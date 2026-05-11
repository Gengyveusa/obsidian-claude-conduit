import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import {
  runRenameProposal,
  type RenameProposalResult,
} from '../../writes/renameProposal';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be non-empty'),
  newName: z
    .string()
    .min(1, 'newName must be non-empty')
    .refine((s) => !s.includes('/'), 'newName must not contain slashes — use move_note for that')
    .refine((s) => !s.startsWith('.'), 'newName must not start with "."'),
});

type Input = z.infer<typeof inputSchema>;

export interface RenameNoteDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/**
 * Construct the `rename_note` write tool per ADR-016 D6.
 *
 * Changes the filename of a markdown file while keeping it in the same
 * folder. `newName` has no extension — `.md` is added automatically. To
 * relocate a note across folders, use `move_note` instead.
 *
 * @example
 *   // Renames '70-Memory/foo.md' → '70-Memory/bar.md'
 *   handler({ path: '70-Memory/foo.md', newName: 'bar' })
 */
export function makeRenameNoteTool(
  deps: RenameNoteDeps,
): ToolDefinition<Input, RenameProposalResult> {
  return {
    name: 'rename_note',
    description:
      'Propose renaming a markdown file in place. ' +
      "`newName` has no extension; '.md' is added automatically. " +
      'Obsidian auto-updates every wikilink that pointed to the file. ' +
      'For cross-folder moves use `move_note` instead. ' +
      "Returns { status: 'applied' | 'rejected' | 'error', fromPath, toPath, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Current vault-relative path of the note.' },
        newName: {
          type: 'string',
          description: "New filename without extension (e.g. 'Welcome'). '.md' is appended.",
        },
      },
      required: ['path', 'newName'],
    },
    handler: async ({ path, newName }) => {
      try {
        assertInVault(path);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', fromPath: path, toPath: path, error: err.message };
        }
        throw err;
      }
      // Derive newPath: replace the basename with newName + .md.
      const lastSlash = path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
      const newPath = dir.length > 0 ? `${dir}/${newName}.md` : `${newName}.md`;

      // No need to assertInVault(newPath) — newName can't introduce
      // traversal because we banned '/' and leading '.' in the schema.
      return runRenameProposal(deps, 'rename_note', path, newPath, { newName });
    },
  };
}
