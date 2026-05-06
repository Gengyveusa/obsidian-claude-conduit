import { z } from 'zod';

import type { MetadataCache, ToolDefinition } from '../types';

const inputSchema = z.object({
  path: z
    .string()
    .min(1, 'path must be non-empty')
    .refine((p) => !p.includes('..'), 'path must not contain ".." segments')
    .refine((p) => !p.startsWith('/'), 'path must be vault-relative (no leading slash)'),
  depth: z.number().int().positive().max(3).default(1),
});

type Input = z.infer<typeof inputSchema>;

export interface NeighborhoodNode {
  path: string;
  depth: number;
  title: string | null;
}

export interface NeighborhoodEdge {
  from: string;
  to: string;
  type: 'wikilink' | 'related' | 'anti_link';
}

export interface NeighborhoodResult {
  origin: string;
  nodes: NeighborhoodNode[];
  edges: NeighborhoodEdge[];
}

/**
 * Construct the `get_graph_neighborhood` tool. BFS through the resolved-
 * link graph N hops from origin (max 3). Bidirectional edges (out + in).
 *
 * v0.1 includes only `wikilink`-typed edges. Frontmatter `related` and
 * `anti_links` arrays are mentioned in spec §4.5 as edge types but are
 * deferred to a later phase — flagging in PR #N's notes.
 *
 * @example
 *   const tool = makeGetGraphNeighborhoodTool(metadataCache);
 *   reg.register(tool);
 */
export function makeGetGraphNeighborhoodTool(
  cache: MetadataCache,
): ToolDefinition<Input, NeighborhoodResult> {
  return {
    name: 'get_graph_neighborhood',
    description:
      "Get the wikilink graph N hops out from a note. Useful for 'pull up everything on X' queries.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        depth: { type: 'integer', default: 1, maximum: 3 },
      },
      required: ['path'],
    },
    handler: ({ path, depth }) => {
      const nodes = new Map<string, NeighborhoodNode>();
      const edges: NeighborhoodEdge[] = [];
      const seenEdges = new Set<string>();

      nodes.set(path, { path, depth: 0, title: titleFor(cache, path) });

      const queue: Array<{ node: string; depth: number }> = [{ node: path, depth: 0 }];
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          continue;
        }
        if (current.depth >= depth) {
          continue;
        }

        // Outbound edges
        const outbound = cache.resolvedLinks[current.node] ?? {};
        for (const target of Object.keys(outbound)) {
          recordEdge(edges, seenEdges, current.node, target);
          if (!nodes.has(target)) {
            nodes.set(target, {
              path: target,
              depth: current.depth + 1,
              title: titleFor(cache, target),
            });
            queue.push({ node: target, depth: current.depth + 1 });
          }
        }

        // Inbound edges (scan resolvedLinks for sources pointing here)
        for (const source of Object.keys(cache.resolvedLinks)) {
          if (cache.resolvedLinks[source][current.node]) {
            recordEdge(edges, seenEdges, source, current.node);
            if (!nodes.has(source)) {
              nodes.set(source, {
                path: source,
                depth: current.depth + 1,
                title: titleFor(cache, source),
              });
              queue.push({ node: source, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedNodes = [...nodes.values()].sort((a, b) =>
        a.depth !== b.depth ? a.depth - b.depth : a.path.localeCompare(b.path),
      );
      edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

      return Promise.resolve({
        origin: path,
        nodes: sortedNodes,
        edges,
      });
    },
  };
}

function recordEdge(
  edges: NeighborhoodEdge[],
  seen: Set<string>,
  from: string,
  to: string,
): void {
  const key = `${from}\0${to}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  edges.push({ from, to, type: 'wikilink' });
}

function titleFor(cache: MetadataCache, path: string): string | null {
  const meta = cache.getFileMetadata(path);
  if (!meta?.frontmatter) {
    return null;
  }
  const title = meta.frontmatter['title'];
  return typeof title === 'string' ? title : null;
}
