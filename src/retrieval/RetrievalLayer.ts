import type { EmbedClient } from './EmbedClient';
import { MODEL, SCHEMA_VERSION, VECTOR_DIM, type SqliteEngine } from './SqliteEngine';
import type { QueryResult } from './types';

export interface RetrievalLayerOpts {
  /** Sagittarius's own DB — vault chunks except 20-Corpus/. */
  selfEngine: SqliteEngine;
  /**
   * corpus-ingest's DB — read-only, owns 20-Corpus/. Optional: if not
   * provided, queryUnified runs against selfEngine alone.
   */
  corpusEngine?: SqliteEngine;
  embedClient: EmbedClient;
}

export interface QueryUnifiedOpts {
  query: string;
  /** Top-K results to return. Default 10, capped at 100 per contract §5. */
  limit?: number;
  /** 'self' = plugin DB only. 'corpus' = corpus DB only. 'both' = unified. Default 'both'. */
  sourceDb?: 'self' | 'corpus' | 'both';
  /** Restrict to notes under this folder path. */
  filterPathPrefix?: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Retrieval-layer entry point. Implements the unified query per
 * docs/embed_interface.md §6: encode the query string once, score against
 * BOTH the plugin's own DB and corpus-ingest's DB (if present), tag
 * results with sourceDb, return top-K by cosine similarity.
 *
 * Schema compat is asserted on construction; foreign DBs raise an
 * actionable error so the operator knows to rebuild corpus-ingest.
 *
 * @example
 *   const layer = new RetrievalLayer({ selfEngine, corpusEngine, embedClient });
 *   const hits = await layer.queryUnified({ query: 'Where does Phase 1 stand?' });
 */
export class RetrievalLayer {
  constructor(private readonly opts: RetrievalLayerOpts) {
    this.assertSchemaCompat();
  }

  private assertSchemaCompat(): void {
    const selfMeta = this.opts.selfEngine.getSchemaMeta();
    if (selfMeta.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `RetrievalLayer: self DB has schema_version='${selfMeta.schemaVersion}', expected '${SCHEMA_VERSION}'. ` +
          `Rebuild the index from Settings → Retrieval → Rebuild from scratch.`,
      );
    }
    if (selfMeta.model !== MODEL) {
      throw new Error(
        `RetrievalLayer: self DB was indexed with '${selfMeta.model}', expected '${MODEL}'. ` +
          `Rebuild the index from Settings → Retrieval → Rebuild from scratch.`,
      );
    }
    if (this.opts.corpusEngine) {
      const corpusMeta = this.opts.corpusEngine.getSchemaMeta();
      if (corpusMeta.schemaVersion !== SCHEMA_VERSION || corpusMeta.model !== MODEL) {
        throw new Error(
          `RetrievalLayer: corpus DB schema mismatch ` +
            `(version='${corpusMeta.schemaVersion}', model='${corpusMeta.model}'). ` +
            `Rebuild corpus-ingest with 'python -m parsers.embed --rebuild' to align schema.`,
        );
      }
    }
  }

  /**
   * Run a unified semantic query across self + corpus DBs.
   * @example const hits = await layer.queryUnified({ query: 'soltura', limit: 8 });
   */
  async queryUnified(opts: QueryUnifiedOpts): Promise<QueryResult[]> {
    const sourceDb = opts.sourceDb ?? 'both';
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 0), MAX_LIMIT);
    if (limit === 0 || opts.query.length === 0) {
      return [];
    }

    const queryVec = await this.opts.embedClient.encode(opts.query);

    const results: QueryResult[] = [];
    if (sourceDb === 'self' || sourceDb === 'both') {
      results.push(...this.scoreEngine(this.opts.selfEngine, queryVec, opts.filterPathPrefix, 'self'));
    }
    if ((sourceDb === 'corpus' || sourceDb === 'both') && this.opts.corpusEngine) {
      results.push(
        ...this.scoreEngine(this.opts.corpusEngine, queryVec, opts.filterPathPrefix, 'corpus'),
      );
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private scoreEngine(
    engine: SqliteEngine,
    queryVec: Float32Array,
    filterPathPrefix: string | undefined,
    sourceDb: 'self' | 'corpus',
  ): QueryResult[] {
    const filter = filterPathPrefix ? { pathPrefix: filterPathPrefix } : undefined;
    const chunks = engine.allChunks(filter);
    const out: QueryResult[] = [];
    for (const chunk of chunks) {
      // Both vectors are L2-normalized by the encoder; cosine sim = dot product.
      const score = clamp01(dot(queryVec, chunk.embedding));
      out.push({
        path: chunk.notePath,
        chunk: chunk.chunkIndex,
        title: null,
        source: null,
        doctrine: null,
        score,
        text: chunk.text,
        sourceDb,
      });
    }
    return out;
  }
}

/** Dot product over equal-length Float32Array vectors. Throws on length mismatch. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `dot: vectors have mismatched lengths (${a.length} vs ${b.length}). ` +
        `Were they produced by different embedding models?`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** Clamp a cosine sim result to [0, 1] per contract §5 ("clamped from [-1, 1] noise"). */
function clamp01(score: number): number {
  if (score < 0) {
    return 0;
  }
  if (score > 1) {
    return 1;
  }
  return score;
}

// VECTOR_DIM is re-exported for callers that need to allocate query vectors directly.
export { VECTOR_DIM };
