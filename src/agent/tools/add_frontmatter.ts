import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import { snapshot, verifyUnchanged, WriteConflictError } from '../../writes/ConflictDetector';
import { setFrontmatterField, type FrontmatterValue } from '../../writes/frontmatterOps';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const valueSchema: z.ZodType<FrontmatterValue, z.ZodTypeDef, unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
  key: z
    .string()
    .min(1, 'key must be non-empty')
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'key must be a simple YAML identifier'),
  value: valueSchema,
  expectedMtime: z.number(),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/, 'expectedHash must be a SHA-256 hex string'),
});

type Input = z.infer<typeof inputSchema>;

export interface AddFrontmatterResult {
  status: 'applied' | 'rejected' | 'error' | 'conflict';
  path: string;
  reason?: string;
  error?: string;
}

export interface AddFrontmatterDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/**
 * Construct the `add_frontmatter` write tool per ADR-016 D6.
 *
 * Adds or updates a single YAML frontmatter field. If the file has no
 * frontmatter block, one is created. If the block is malformed, the tool
 * errors rather than risk overwriting user data.
 *
 * Supported value types: string, number, boolean, string[]. Other shapes
 * (nested objects, mixed-type arrays) need a richer tool — out of scope
 * for v0.3.x.
 *
 * @example
 *   const tool = makeAddFrontmatterTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makeAddFrontmatterTool(
  deps: AddFrontmatterDeps,
): ToolDefinition<Input, AddFrontmatterResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'add_frontmatter',
    description:
      "Propose adding or updating a single YAML frontmatter field on an existing note. " +
      "If the file has no frontmatter block, one is created. " +
      "Value can be string, number, boolean, or string[]. " +
      'Pass `expectedMtime` and `expectedHash` from a prior `read_note` call so the tool can detect concurrent edits. ' +
      "Returns { status: 'applied' | 'rejected' | 'conflict' | 'error', path, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the note.' },
        key: {
          type: 'string',
          description: "YAML key. Identifier-style: letters, digits, '_', '-'.",
        },
        value: {
          description:
            'Value to set. One of: string, number, boolean, or array of strings.',
        },
        expectedMtime: { type: 'number', description: 'mtime from the prior read_note result.' },
        expectedHash: { type: 'string', description: 'hash from the prior read_note result.' },
      },
      required: ['path', 'key', 'value', 'expectedMtime', 'expectedHash'],
    },
    handler: async ({ path, key, value, expectedMtime, expectedHash }) => {
      try {
        assertInVault(path);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', path, error: err.message };
        }
        throw err;
      }

      if (!(await deps.adapter.exists(path))) {
        return { status: 'error', path, error: `File does not exist: ${path}.` };
      }

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

      const priorContent = await deps.adapter.read(path);

      let newContent: string;
      try {
        newContent = setFrontmatterField(priorContent, key, value);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', path, error: msg };
      }

      const proposal: Proposal = {
        toolName: 'add_frontmatter',
        args: { path, key, value, expectedMtime, expectedHash },
        diff: {
          kind: 'patch-file',
          path,
          before: priorContent,
          after: newContent,
        },
        apply: async () => {
          await verifyUnchanged(deps.adapter, path, before);
          await deps.adapter.write(path, newContent);
          return {
            toolName: 'add_frontmatter',
            path,
            appliedAt: now(),
            inverse: { kind: 'write-file', path, content: priorContent },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: AddFrontmatterResult = { status: 'rejected', path };
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
          return { status: 'conflict', path, reason: err.message };
        }
        throw err;
      }
    },
  };
}
