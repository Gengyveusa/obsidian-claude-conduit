import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
});

type Input = z.infer<typeof inputSchema>;

/**
 * Result returned to the caller after a `delete_note` proposal is
 * decided. Mirrors the shape of `create_note` for symmetry — `create`
 * and `delete` are inverses, and the curator's duplicate-merge apply
 * path pairs them.
 */
export interface DeleteNoteResult {
  status: 'applied' | 'rejected' | 'error';
  path: string;
  /** Present when `status === 'rejected'`. The user's stated reason, if any. */
  reason?: string;
  /** Present when `status === 'error'`. Machine-readable error context. */
  error?: string;
}

export interface DeleteNoteDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  /** Injectable clock for tests. Returns epoch seconds. */
  now?: () => number;
}

/**
 * Construct the `delete_note` write tool (v1.0.7).
 *
 * Inverse-symmetric with `create_note`:
 *   - `create_note` writes a file; inverse op `{ kind: 'delete-file' }`.
 *   - `delete_note` removes a file; inverse op
 *     `{ kind: 'write-file', path, content }` restoring the prior body.
 *
 * Lifecycle:
 *   1. P1 vault-traversal guard.
 *   2. Refuse if the file doesn't exist.
 *   3. Read + snapshot prior content for the inverse + the diff card.
 *   4. Hand a `delete-file` `Proposal` to the approval gate.
 *   5. On accept → adapter.delete + record inverse `write-file` op.
 *
 * The user sees every line of the doomed file rendered as `-` in the
 * diff card so they can sanity-check before approving. Undo restores
 * the file byte-for-byte.
 *
 * @example
 *   const tool = makeDeleteNoteTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makeDeleteNoteTool(
  deps: DeleteNoteDeps,
): ToolDefinition<Input, DeleteNoteResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'delete_note',
    description:
      'Propose deleting a markdown file at the given vault-relative path. ' +
      'The user must approve in the chat UI before the file is removed. ' +
      'Refuses if the path does not exist or escapes the vault. Undo restores ' +
      "the file with its prior content. Returns { status: 'applied' | 'rejected' | 'error', path, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Vault-relative path of the markdown file to delete. Must exist. ' +
            'Undo replays a `write-file` op that restores the prior body.',
        },
      },
      required: ['path'],
    },
    handler: async ({ path }) => {
      try {
        assertInVault(path);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', path, error: err.message };
        }
        throw err;
      }

      if (!(await deps.adapter.exists(path))) {
        return {
          status: 'error',
          path,
          error: `File does not exist: ${path}. Nothing to delete.`,
        };
      }

      // Capture prior content so the inverse can restore the file
      // verbatim on undo. Read happens once; if the user edits the
      // file between propose and apply, the inverse rolls back to
      // the *propose-time* content (consistent with `write-file`
      // semantics in TransactionReplayer).
      const priorContent = await deps.adapter.read(path);

      const proposal: Proposal = {
        toolName: 'delete_note',
        args: { path },
        diff: { kind: 'delete-file', path, content: priorContent },
        apply: async () => {
          await deps.adapter.delete(path);
          return {
            toolName: 'delete_note',
            path,
            appliedAt: now(),
            inverse: { kind: 'write-file', path, content: priorContent },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: DeleteNoteResult = { status: 'rejected', path };
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
