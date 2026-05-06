import { z } from 'zod';

import type { MetadataCache, ToolDefinition } from '../types';

const inputSchema = z.object({
  path: z
    .string()
    .min(1, 'path must be non-empty')
    .refine((p) => !p.includes('..'), 'path must not contain ".." segments')
    .refine((p) => !p.startsWith('/'), 'path must be vault-relative (no leading slash)'),
});

type Input = z.infer<typeof inputSchema>;

export interface BacklinksResult {
  target: string;
  inbound: Array<{ path: string; line_numbers: number[] }>;
  total: number;
}

/**
 * Construct the `get_backlinks` tool. Returns every note that contains
 * a resolved wikilink to the target, with the line numbers where each
 * link occurs in the source. Reads only the resolved-links graph;
 * unresolved/dangling links are out of scope per spec §4.4.
 *
 * @example
 *   const tool = makeGetBacklinksTool(metadataCache);
 *   reg.register(tool);
 */
export function makeGetBacklinksTool(
  cache: MetadataCache,
): ToolDefinition<Input, BacklinksResult> {
  return {
    name: 'get_backlinks',
    description: 'Get all notes that link to the given note via wikilinks.',
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Vault-relative path of the target note.",
        },
      },
      required: ['path'],
    },
    handler: ({ path }) => {
      const inbound: Array<{ path: string; line_numbers: number[] }> = [];
      for (const sourcePath of Object.keys(cache.resolvedLinks)) {
        const outbound = cache.resolvedLinks[sourcePath];
        if (!outbound[path]) {
          continue;
        }
        const meta = cache.getFileMetadata(sourcePath);
        const lineNumbers: number[] = [];
        if (meta) {
          for (const linkRef of meta.links) {
            const resolved = cache.resolveLink(linkRef.link, sourcePath);
            if (resolved === path) {
              lineNumbers.push(linkRef.line);
            }
          }
        }
        inbound.push({ path: sourcePath, line_numbers: lineNumbers });
      }
      inbound.sort((a, b) => a.path.localeCompare(b.path));
      return Promise.resolve({
        target: path,
        inbound,
        total: inbound.length,
      });
    },
  };
}
