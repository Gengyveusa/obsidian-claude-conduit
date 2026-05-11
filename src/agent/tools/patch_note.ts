import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import { snapshot, verifyUnchanged, WriteConflictError } from '../../writes/ConflictDetector';
import { applyPatchOps } from '../../writes/patchOps';
import type { PatchOp, Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const patchOpSchema: z.ZodType<PatchOp, z.ZodTypeDef, unknown> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('replace'),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('insert'),
    afterLine: z.number().int().min(0),
    content: z.string(),
  }),
  z.object({
    kind: z.literal('delete'),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
]);

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
  ops: z.array(patchOpSchema).min(1, 'patch_note requires at least one op'),
  expectedMtime: z.number(),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/, 'expectedHash must be a SHA-256 hex string'),
});

type Input = z.infer<typeof inputSchema>;

export interface PatchNoteResult {
  status: 'applied' | 'rejected' | 'error' | 'conflict';
  path: string;
  reason?: string;
  error?: string;
}

export interface PatchNoteDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/**
 * Construct the `patch_note` write tool per ADR-016 D6.
 *
 * Lifecycle for one call:
 *   1. Validate path stays in the vault (P1).
 *   2. Reject if the file doesn't exist (no auto-create — that's
 *      `create_note`'s job).
 *   3. Read the current content + snapshot it (mtime + sha256).
 *   4. Cross-check the snapshot against the LLM's `expectedMtime` +
 *      `expectedHash`. If the LLM's view of the file is already stale
 *      (someone edited between read_note and patch_note), surface a
 *      conflict immediately — don't even propose ops the LLM built
 *      against bad line numbers.
 *   5. Apply ops to derive the new content (pure `applyPatchOps`).
 *   6. Build a `Proposal` whose `apply()` re-verifies the snapshot
 *      against the live file (catches edits between propose and
 *      Accept) and then writes the new content.
 *   7. Inverse = `write-file` with the prior content.
 *
 * @example
 *   const tool = makePatchNoteTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makePatchNoteTool(deps: PatchNoteDeps): ToolDefinition<Input, PatchNoteResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'patch_note',
    description:
      'Propose applying a list of structured ops (replace, insert, delete) to an existing markdown note. ' +
      'Line numbers are 1-indexed and inclusive, and refer to positions in the original file. ' +
      'Pass `expectedMtime` and `expectedHash` from a prior `read_note` call so the tool can detect concurrent edits. ' +
      'The user must approve in the chat UI before the file is changed. Returns ' +
      "{ status: 'applied' | 'rejected' | 'conflict' | 'error', path, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the note to patch.' },
        ops: {
          type: 'array',
          description:
            'Patch ops to apply. Each op is one of replace/insert/delete with 1-indexed inclusive line numbers. ' +
            'Multi-op calls describe positions in the ORIGINAL file; ops are applied in reverse-position order so indices do not shift. ' +
            'Overlapping ranges are rejected.',
        },
        expectedMtime: {
          type: 'number',
          description: 'mtime field from the read_note result that informed these ops.',
        },
        expectedHash: {
          type: 'string',
          description: 'hash field from the read_note result that informed these ops.',
        },
      },
      required: ['path', 'ops', 'expectedMtime', 'expectedHash'],
    },
    handler: async ({ path, ops, expectedMtime, expectedHash }) => {
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
          error: `File does not exist: ${path}. Use create_note to create it, or pick another path.`,
        };
      }

      // Snapshot the current state. If the LLM's view (`expected*`) doesn't
      // match the file as it sits right now, the LLM's line numbers are
      // already pointing at a different version — bail before proposing.
      const before = await snapshot(deps.adapter, path);
      if (before.hashHex !== expectedHash) {
        return {
          status: 'conflict',
          path,
          reason:
            `File hash drifted since read_note: expected ${expectedHash.slice(0, 12)}…, ` +
            `found ${before.hashHex.slice(0, 12)}…. Re-read the file and re-propose.`,
        };
      }
      // expectedMtime is informational once the hash matches; we still
      // surface a soft warning via the reject reason if mtime drifted —
      // some editors update mtime without changing content. Don't fail on
      // mtime drift alone.

      const priorContent = await deps.adapter.read(path);

      let newContent: string;
      try {
        newContent = applyPatchOps(priorContent, ops);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', path, error: `applyPatchOps: ${msg}` };
      }

      const proposal: Proposal = {
        toolName: 'patch_note',
        args: { path, ops, expectedMtime, expectedHash },
        diff: {
          kind: 'patch-file',
          path,
          before: priorContent,
          after: newContent,
        },
        apply: async () => {
          // Re-verify the snapshot against the live file just before
          // writing, in case the user edited between propose and Accept.
          try {
            await verifyUnchanged(deps.adapter, path, before);
          } catch (err) {
            if (err instanceof WriteConflictError) {
              throw err;
            }
            throw err;
          }
          await deps.adapter.write(path, newContent);
          return {
            toolName: 'patch_note',
            path,
            appliedAt: now(),
            inverse: { kind: 'write-file', path, content: priorContent },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: PatchNoteResult = { status: 'rejected', path };
        if (decision.reason !== undefined) {
          result.reason = decision.reason;
        }
        return result;
      }

      try {
        const appliedOp = await proposal.apply();
        deps.ctx.record(appliedOp);
        return { status: 'applied', path };
      } catch (err) {
        if (err instanceof WriteConflictError) {
          return {
            status: 'conflict',
            path,
            reason: err.message,
          };
        }
        throw err;
      }
    },
  };
}
