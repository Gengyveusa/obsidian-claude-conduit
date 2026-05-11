import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
  content: z.string(),
});

type Input = z.infer<typeof inputSchema>;

/**
 * Result returned to the LLM after a `create_note` proposal is decided.
 *
 * `status` lets the LLM tell what happened in one field:
 *   - `applied`: the file was created; the assistant can refer to it.
 *   - `rejected`: the user said no; the assistant should reconsider.
 *   - `error`: the proposal failed before the user even saw it
 *     (e.g. path conflict, validation error). Treated as a hard failure.
 */
export interface CreateNoteResult {
  status: 'applied' | 'rejected' | 'error';
  path: string;
  /** Present when `status === 'rejected'`. The user's stated reason, if any. */
  reason?: string;
  /** Present when `status === 'error'`. Machine-readable error context. */
  error?: string;
}

export interface CreateNoteDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  /** Injectable clock for tests. Returns epoch seconds. */
  now?: () => number;
}

/**
 * Construct the `create_note` write tool per ADR-016 D6.
 *
 * Lifecycle for one call:
 *   1. Validate the path stays in the vault (ADR-016 P1 — `assertInVault`).
 *   2. Refuse if the file already exists (no clobber).
 *   3. Build a `Proposal` with an `apply` closure that writes the file.
 *   4. Hand the proposal to `gate.request(...)` — UI blocks on the user.
 *   5. On `accept`: run `apply()`, record an inverse op
 *      (`delete-file`) into the transaction log, return `status: 'applied'`.
 *   6. On `reject`: return `status: 'rejected'` with the user's reason.
 *
 * @example
 *   const tool = makeCreateNoteTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makeCreateNoteTool(deps: CreateNoteDeps): ToolDefinition<Input, CreateNoteResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'create_note',
    description:
      'Propose creating a new markdown file at the given vault-relative path. ' +
      'The user must approve in the chat UI before the file is created. ' +
      "Refuses if the path already exists or escapes the vault. Returns " +
      "{ status: 'applied' | 'rejected' | 'error', path, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Vault-relative path, e.g. '70-Memory/conversations/2026-05-11/notes.md'. " +
            "Must not exist already. Parent dirs are created automatically.",
        },
        content: {
          type: 'string',
          description: 'Full markdown body for the new file (UTF-8, no BOM).',
        },
      },
      required: ['path', 'content'],
    },
    handler: async ({ path, content }) => {
      // P1: path-traversal guard. Reject early before any side effects.
      try {
        assertInVault(path);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', path, error: err.message };
        }
        throw err;
      }

      // No-clobber check. The tool is "create", not "create-or-overwrite";
      // overwriting an existing file is a different, more dangerous
      // operation that the LLM should opt into via `patch_note` (v0.3.x).
      if (await deps.adapter.exists(path)) {
        return {
          status: 'error',
          path,
          error: `File already exists: ${path}. Use patch_note (coming in v0.3.x) or pick a different path.`,
        };
      }

      const proposal: Proposal = {
        toolName: 'create_note',
        args: { path, content },
        diff: { kind: 'create-file', path, content },
        apply: async () => {
          await deps.adapter.write(path, content);
          return {
            toolName: 'create_note',
            path,
            appliedAt: now(),
            inverse: { kind: 'delete-file', path },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: CreateNoteResult = { status: 'rejected', path };
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
