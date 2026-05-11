import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import {
  snapshot,
  verifyUnchanged,
  WriteConflictError,
} from '../../writes/ConflictDetector';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  fromPath: z.string().min(1, 'fromPath must be non-empty'),
  toPath: z.string().min(1, 'toPath must be non-empty'),
  /**
   * If provided, the wikilink is inserted on the next line AFTER the first
   * line in `fromPath` whose trimmed text matches `anchorInFrom` (exact
   * match, case sensitive). If omitted, the wikilink is appended at the
   * end of the body with one blank line separator.
   */
  anchorInFrom: z.string().min(1).optional(),
  expectedMtime: z.number(),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/, 'expectedHash must be a SHA-256 hex string'),
});

type Input = z.infer<typeof inputSchema>;

export interface LinkNotesResult {
  status: 'applied' | 'rejected' | 'error' | 'conflict';
  fromPath: string;
  toPath: string;
  reason?: string;
  error?: string;
}

export interface LinkNotesDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/**
 * Insert a `[[wikilink]]` reference into `fromPath` pointing at `toPath`.
 * Behavior matches `add_frontmatter` / `patch_note` for conflict handling:
 * `expectedMtime` + `expectedHash` from a prior `read_note` are required.
 *
 * Insertion position:
 *   - If `anchorInFrom` matches a line in the body: insert on the next
 *     line right after the anchor.
 *   - Otherwise: append at end of body with a blank-line separator.
 *
 * Wikilink format: `[[toPath]]`. We don't strip `.md` or shorten the
 * link — Obsidian's metadata cache resolves the full path naturally and
 * the LLM can always pass a shorter form if it prefers.
 *
 * Inverse op = `write-file` with the prior content (matches the
 * read-modify-write trio's inverse shape).
 */
export function makeLinkNotesTool(
  deps: LinkNotesDeps,
): ToolDefinition<Input, LinkNotesResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'link_notes',
    description:
      'Propose inserting a [[wikilink]] reference from one note to another. ' +
      'If `anchorInFrom` is given, the link is inserted on the line after the first matching line in `fromPath`. ' +
      'Otherwise it appends at the bottom with a blank-line separator. ' +
      'Pass `expectedMtime` and `expectedHash` from a prior `read_note` call so the tool can detect concurrent edits. ' +
      "Returns { status: 'applied' | 'rejected' | 'conflict' | 'error', fromPath, toPath, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        fromPath: { type: 'string', description: 'Vault-relative path of the note to add the link in.' },
        toPath: {
          type: 'string',
          description: 'Vault-relative path of the linked-to note (will be wrapped in [[...]]).',
        },
        anchorInFrom: {
          type: 'string',
          description:
            "Optional. Exact text of a line in `fromPath`; the link is inserted on the next line after it. " +
            'If omitted, the link is appended at the end of the body.',
        },
        expectedMtime: { type: 'number', description: 'mtime from a prior read_note on fromPath.' },
        expectedHash: { type: 'string', description: 'hash from a prior read_note on fromPath.' },
      },
      required: ['fromPath', 'toPath', 'expectedMtime', 'expectedHash'],
    },
    handler: async ({ fromPath, toPath, anchorInFrom, expectedMtime, expectedHash }) => {
      try {
        assertInVault(fromPath);
        assertInVault(toPath);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', fromPath, toPath, error: err.message };
        }
        throw err;
      }

      if (!(await deps.adapter.exists(fromPath))) {
        return { status: 'error', fromPath, toPath, error: `Source file does not exist: ${fromPath}.` };
      }

      const before = await snapshot(deps.adapter, fromPath);
      if (before.hashHex !== expectedHash) {
        return {
          status: 'conflict',
          fromPath,
          toPath,
          reason:
            `${fromPath} hash drifted since read_note: expected ${expectedHash.slice(0, 12)}…, ` +
            `found ${before.hashHex.slice(0, 12)}…. Re-read and re-propose.`,
        };
      }

      const priorContent = await deps.adapter.read(fromPath);
      const wikilink = `[[${toPath}]]`;
      const newContent = insertWikilink(priorContent, wikilink, anchorInFrom);

      // No-op detection: if the link is already in place, surface as error.
      if (newContent === priorContent) {
        return {
          status: 'error',
          fromPath,
          toPath,
          error:
            anchorInFrom !== undefined
              ? `Anchor line not found in ${fromPath}: ${JSON.stringify(anchorInFrom)}.`
              : `Link ${wikilink} already exists in ${fromPath} (nothing to insert).`,
        };
      }

      const proposal: Proposal = {
        toolName: 'link_notes',
        args: { fromPath, toPath, expectedMtime, expectedHash, ...(anchorInFrom !== undefined && { anchorInFrom }) },
        diff: {
          kind: 'patch-file',
          path: fromPath,
          before: priorContent,
          after: newContent,
        },
        apply: async () => {
          await verifyUnchanged(deps.adapter, fromPath, before);
          await deps.adapter.write(fromPath, newContent);
          return {
            toolName: 'link_notes',
            path: fromPath,
            appliedAt: now(),
            inverse: { kind: 'write-file', path: fromPath, content: priorContent },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: LinkNotesResult = { status: 'rejected', fromPath, toPath };
        if (decision.reason !== undefined) {
          result.reason = decision.reason;
        }
        return result;
      }

      try {
        const appliedOp = await proposal.apply();
        deps.ctx.record(appliedOp);
        return { status: 'applied', fromPath, toPath };
      } catch (err) {
        if (err instanceof WriteConflictError) {
          return { status: 'conflict', fromPath, toPath, reason: err.message };
        }
        throw err;
      }
    },
  };
}

/**
 * Pure insertion of `wikilink` into `content`.
 *
 *   - If `anchor` is given and matches a line: insert immediately after.
 *     Returns the input unchanged if the anchor isn't found (caller
 *     surfaces this as an error).
 *   - If `anchor` is given but missing: return unchanged.
 *   - If `anchor` is undefined: append at end with a blank-line separator,
 *     unless the link already exists in the content (returns unchanged).
 *
 * Exported for tests.
 */
export function insertWikilink(
  content: string,
  wikilink: string,
  anchor: string | undefined,
): string {
  if (anchor !== undefined) {
    const lines = content.split('\n');
    const idx = lines.findIndex((line) => line.trim() === anchor.trim());
    if (idx === -1) {
      return content;
    }
    lines.splice(idx + 1, 0, wikilink);
    return lines.join('\n');
  }

  // Anchor-less append. Skip if the link is already present.
  if (content.includes(wikilink)) {
    return content;
  }
  // Blank-line separator unless content already ends in one.
  if (content.length === 0) {
    return wikilink;
  }
  if (content.endsWith('\n\n')) {
    return content + wikilink;
  }
  if (content.endsWith('\n')) {
    return content + '\n' + wikilink;
  }
  return content + '\n\n' + wikilink;
}
