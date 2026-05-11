import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
  content: z.string(),
  createIfMissing: z.boolean().optional().default(false),
});

type Input = z.infer<typeof inputSchema>;

export interface AppendToNoteResult {
  status: 'applied' | 'rejected' | 'error';
  path: string;
  reason?: string;
  error?: string;
}

export interface AppendToNoteDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/** Last N lines of `text` joined back with newlines, for the diff card preview. */
function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * Append `addition` to `prior` with a clean blank-line separator.
 * Cases:
 *   - prior empty → `addition`
 *   - prior ends in `\n\n` → already separated → `prior + addition`
 *   - prior ends in `\n` → one more `\n` → `prior + '\n' + addition`
 *   - prior ends in any other char → `prior + '\n\n' + addition`
 *
 * Exported for tests so we can verify each case explicitly.
 */
export function appendWithSeparator(prior: string, addition: string): string {
  if (prior.length === 0) {
    return addition;
  }
  if (prior.endsWith('\n\n')) {
    return prior + addition;
  }
  if (prior.endsWith('\n')) {
    return prior + '\n' + addition;
  }
  return prior + '\n\n' + addition;
}

/**
 * Construct the `append_to_note` write tool per ADR-016 D6.
 *
 * Lifecycle for one call:
 *   1. Validate the path stays in the vault (P1).
 *   2. If the file doesn't exist: respect `createIfMissing` —
 *      true → behave like `create_note`; false → return `status: 'error'`.
 *   3. Read the prior content (for the diff card preview + the inverse op).
 *   4. Build a `Proposal` whose `apply()` appends with one leading
 *      blank line separator if the existing content doesn't already
 *      end in a newline.
 *   5. Inverse op = `{ kind: 'write-file', path, content: priorContent }` —
 *      restoring the pre-append state.
 *
 * Note: no conflict detection here yet. ADR-016 D4 + P2 add `expectedMtime`
 * + `expectedHash` checks when `ConflictDetector` lands in v0.3.x (with
 * `patch_note`). v0.3.0 ships the trusting-of-mtime version; revisit before
 * `patch_note` PR.
 *
 * @example
 *   const tool = makeAppendToNoteTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makeAppendToNoteTool(
  deps: AppendToNoteDeps,
): ToolDefinition<Input, AppendToNoteResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'append_to_note',
    description:
      'Propose appending content to the end of an existing markdown note. ' +
      'The user must approve in the chat UI before the file is changed. ' +
      "If the file doesn't exist, errors unless `createIfMissing` is true. " +
      "Returns { status: 'applied' | 'rejected' | 'error', path, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the note to append to.' },
        content: {
          type: 'string',
          description:
            'Content to append. A blank line is inserted before it if the existing file does not already end with one.',
        },
        createIfMissing: {
          type: 'boolean',
          description:
            "If true and the file doesn't exist, the file is created with `content` as its body. Defaults to false.",
        },
      },
      required: ['path', 'content'],
    },
    handler: async ({ path, content, createIfMissing }) => {
      try {
        assertInVault(path);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', path, error: err.message };
        }
        throw err;
      }

      const exists = await deps.adapter.exists(path);
      if (!exists && !createIfMissing) {
        return {
          status: 'error',
          path,
          error:
            `File does not exist: ${path}. ` +
            'Pass createIfMissing: true to create it, or use create_note for a fresh file.',
        };
      }

      const priorContent = exists ? await deps.adapter.read(path) : '';
      const newContent = appendWithSeparator(priorContent, content);

      const proposal: Proposal = {
        toolName: 'append_to_note',
        args: { path, content, createIfMissing },
        diff: {
          kind: 'append-to-file',
          path,
          existingTail: tailLines(priorContent, 5),
          appendedContent: content,
        },
        apply: async () => {
          await deps.adapter.write(path, newContent);
          return {
            toolName: 'append_to_note',
            path,
            appliedAt: now(),
            inverse: exists
              ? { kind: 'write-file', path, content: priorContent }
              : { kind: 'delete-file', path },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: AppendToNoteResult = { status: 'rejected', path };
        if (decision.reason !== undefined) {
          result.reason = decision.reason;
        }
        return result;
      }

      const appliedOp = await proposal.apply();
      deps.ctx.record(appliedOp);
      return { status: 'applied', path };
    },
  };
}
