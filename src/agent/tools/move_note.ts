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
  fromPath: z.string().min(1, 'fromPath must be non-empty'),
  toPath: z.string().min(1, 'toPath must be non-empty'),
});

type Input = z.infer<typeof inputSchema>;

export interface MoveNoteDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

/**
 * Construct the `move_note` write tool per ADR-016 D6.
 *
 * Moves the file at `fromPath` to `toPath`. The destination must be a
 * full vault-relative path (including the filename); use `rename_note`
 * if you just want to change the filename within the same folder.
 *
 * Obsidian's metadata cache auto-updates every wikilink across the vault
 * to point to the new location — that's the reason this lives in
 * v0.4.1 (with renameFile() going through `app.fileManager.renameFile()`
 * not `adapter.write()`).
 *
 * Inverse op: rename-file back to the original location.
 *
 * @example
 *   const tool = makeMoveNoteTool({ adapter, gate, ctx });
 *   reg.register(tool);
 */
export function makeMoveNoteTool(deps: MoveNoteDeps): ToolDefinition<Input, RenameProposalResult> {
  return {
    name: 'move_note',
    description:
      'Propose moving a markdown file to a new vault-relative path. ' +
      'Obsidian auto-updates every wikilink that pointed to the file. ' +
      'Refuses if the destination already exists or either path escapes the vault. ' +
      "Returns { status: 'applied' | 'rejected' | 'error', fromPath, toPath, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        fromPath: {
          type: 'string',
          description: 'Current vault-relative path of the note to move.',
        },
        toPath: {
          type: 'string',
          description:
            'Destination vault-relative path. Include the filename. Parent folders are auto-created.',
        },
      },
      required: ['fromPath', 'toPath'],
    },
    handler: async ({ fromPath, toPath }) => {
      try {
        assertInVault(fromPath);
        assertInVault(toPath);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', fromPath, toPath, error: err.message };
        }
        throw err;
      }
      return runRenameProposal(deps, 'move_note', fromPath, toPath);
    },
  };
}
