import { z } from 'zod';

import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z
    .string()
    .min(1, 'path must be non-empty')
    .refine((p) => !p.includes('..'), 'path must not contain ".." segments')
    .refine((p) => !p.startsWith('/'), 'path must be vault-relative (no leading slash)'),
  recursive: z.boolean().default(false),
});

type Input = z.infer<typeof inputSchema>;

export interface ListFolderResult {
  folder: string;
  notes: Array<{ path: string; size_bytes: number; mtime: number }>;
  subfolders: string[];
}

/**
 * Construct the `list_folder` tool. Lists `.md` notes in a vault folder
 * with their stat info, plus immediate subfolders. Recursive mode walks
 * the whole subtree.
 *
 * @example
 *   const tool = makeListFolderTool(app.vault.adapter);
 *   reg.register(tool);
 */
export function makeListFolderTool(adapter: VaultAdapter): ToolDefinition<Input, ListFolderResult> {
  return {
    name: 'list_folder',
    description:
      'List the markdown notes in a vault folder. Optional recursive walks the subtree.',
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Vault-relative folder path, e.g. '50-FortressFlow'.",
        },
        recursive: {
          type: 'boolean',
          default: false,
          description: 'If true, walks the entire subtree.',
        },
      },
      required: ['path'],
    },
    handler: async ({ path, recursive }) => {
      const rootListing = await adapter.list(path);
      const notes: Array<{ path: string; size_bytes: number; mtime: number }> = [];
      const subfolders: string[] = [...rootListing.folders];

      const queue: string[] = recursive ? [...rootListing.folders] : [];
      const visited = new Set<string>([path]);

      // Add root-level files
      for (const filePath of rootListing.files) {
        if (filePath.endsWith('.md')) {
          const stat = await adapter.stat(filePath);
          if (stat) {
            notes.push({ path: filePath, size_bytes: stat.size, mtime: stat.mtime });
          }
        }
      }

      while (queue.length > 0) {
        const folder = queue.shift();
        if (!folder || visited.has(folder)) {
          continue;
        }
        visited.add(folder);
        const listing = await adapter.list(folder);
        for (const filePath of listing.files) {
          if (filePath.endsWith('.md')) {
            const stat = await adapter.stat(filePath);
            if (stat) {
              notes.push({ path: filePath, size_bytes: stat.size, mtime: stat.mtime });
            }
          }
        }
        for (const sub of listing.folders) {
          queue.push(sub);
        }
      }

      notes.sort((a, b) => a.path.localeCompare(b.path));
      subfolders.sort();

      return { folder: path, notes, subfolders };
    },
  };
}
