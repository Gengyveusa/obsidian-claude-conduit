import { z } from 'zod';

import type { RetrievalLayer } from '../../retrieval/RetrievalLayer';
import type { ToolDefinition } from '../types';

const inputSchema = z.object({
  query: z.string().min(1, 'query must be non-empty'),
  limit: z.number().int().positive().max(100).default(8),
  source_db: z.enum(['self', 'corpus', 'both']).default('both'),
  filter_path_prefix: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface SearchVaultHit {
  path: string;
  chunk: number;
  title: string | null;
  source: string | null;
  doctrine: string | null;
  score: number;
  text: string;
  source_db?: 'self' | 'corpus';
}

/**
 * Construct the `search_vault` tool. Wraps RetrievalLayer.queryUnified
 * to expose semantic search to the agent. Translates between the spec's
 * snake_case I/O contract and the layer's camelCase API.
 *
 * @example
 *   const tool = makeSearchVaultTool(retrieval);
 *   reg.register(tool);
 */
export function makeSearchVaultTool(
  retrieval: RetrievalLayer,
): ToolDefinition<Input, SearchVaultHit[]> {
  return {
    name: 'search_vault',
    description:
      'Semantic + lexical search across the vault. Returns top-K matched chunks with scores and citations.',
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 8, maximum: 100 },
        source_db: {
          type: 'string',
          enum: ['self', 'corpus', 'both'],
          default: 'both',
          description:
            "self=plugin's own vault index; corpus=20-Corpus index; both=unified",
        },
        filter_path_prefix: {
          type: 'string',
          description:
            "Optional. Restrict to notes under this folder, e.g. '40-Quantum-Distillery/'.",
        },
      },
      required: ['query'],
    },
    handler: async ({ query, limit, source_db, filter_path_prefix }) => {
      const queryOpts = {
        query,
        limit,
        sourceDb: source_db,
        ...(filter_path_prefix !== undefined ? { filterPathPrefix: filter_path_prefix } : {}),
      };
      const results = await retrieval.queryUnified(queryOpts);
      // Translate camelCase → snake_case for the spec's documented output.
      return results.map((r) => {
        const hit: SearchVaultHit = {
          path: r.path,
          chunk: r.chunk,
          title: r.title,
          source: r.source,
          doctrine: r.doctrine,
          score: r.score,
          text: r.text,
        };
        if (r.sourceDb !== undefined) {
          hit.source_db = r.sourceDb;
        }
        return hit;
      });
    },
  };
}
