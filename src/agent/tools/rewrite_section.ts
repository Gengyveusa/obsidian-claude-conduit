import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import { snapshot, verifyUnchanged, WriteConflictError } from '../../writes/ConflictDetector';
import { rewriteSection } from '../../writes/sectionOps';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
  sectionHeader: z
    .string()
    .min(1, 'sectionHeader must be non-empty')
    .regex(/^#{1,6}\s/, 'sectionHeader must start with a # prefix (e.g. "## Setup")'),
  newBody: z.string(),
  expectedMtime: z.number(),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/, 'expectedHash must be a SHA-256 hex string'),
});

type Input = z.infer<typeof inputSchema>;

export interface RewriteSectionResult {
  status: 'applied' | 'rejected' | 'error' | 'conflict';
  path: string;
  reason?: string;
  error?: string;
}

export interface RewriteSectionDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/**
 * Construct the `rewrite_section` write tool per ADR-016 D6.
 *
 * Replaces the body content under a specific markdown heading. The
 * heading itself stays put; only the lines between this heading and the
 * next heading of equal-or-lesser depth (or EOF) are rewritten.
 *
 * Same propose-then-apply + ConflictDetector pattern as `patch_note`.
 *
 * @example
 *   const tool = makeRewriteSectionTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makeRewriteSectionTool(
  deps: RewriteSectionDeps,
): ToolDefinition<Input, RewriteSectionResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'rewrite_section',
    description:
      'Propose replacing the body of a specific markdown section (under a `# Header` or `## Subheader`). ' +
      'The heading itself is preserved; only lines between this heading and the next ' +
      'heading of equal-or-lesser depth are replaced. ' +
      'Pass `expectedMtime` and `expectedHash` from a prior `read_note` call so the tool can detect concurrent edits. ' +
      'The user must approve in the chat UI before the file is changed. Returns ' +
      "{ status: 'applied' | 'rejected' | 'conflict' | 'error', path, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path of the note.' },
        sectionHeader: {
          type: 'string',
          description:
            'Exact heading text including the # prefix, e.g. `## Setup`. ' +
            'Matched against trimmed line text; the first match wins.',
        },
        newBody: {
          type: 'string',
          description:
            'New body content for the section. Inserted verbatim; include a trailing newline if you want one.',
        },
        expectedMtime: { type: 'number', description: 'mtime from the prior read_note result.' },
        expectedHash: { type: 'string', description: 'hash from the prior read_note result.' },
      },
      required: ['path', 'sectionHeader', 'newBody', 'expectedMtime', 'expectedHash'],
    },
    handler: async ({ path, sectionHeader, newBody, expectedMtime, expectedHash }) => {
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
        newContent = rewriteSection(priorContent, sectionHeader, newBody);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', path, error: msg };
      }

      const proposal: Proposal = {
        toolName: 'rewrite_section',
        args: { path, sectionHeader, newBody, expectedMtime, expectedHash },
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
            toolName: 'rewrite_section',
            path,
            appliedAt: now(),
            inverse: { kind: 'write-file', path, content: priorContent },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: RewriteSectionResult = { status: 'rejected', path };
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
