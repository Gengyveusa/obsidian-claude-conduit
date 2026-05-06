/**
 * Retrieval-layer types — shared between SqliteEngine, EmbedClient, and
 * RetrievalLayer. Mirror the embedding contract (docs/embed_interface.md §3, §5)
 * but use camelCase for TypeScript ergonomics; the SQL columns stay snake_case.
 */

/** Cosine similarity, clamped to [0, 1]. */
export type Score = number;

/** A row in the `chunks` table — one embedded chunk of a note. */
export interface Chunk {
  notePath: string;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
}

/** A row in the `notes` table — one note's metadata. */
export interface Note {
  path: string;
  title: string | null;
  source: string | null;
  doctrineAlignment: string | null;
  lastModified: number;
  chunkCount: number;
}

/**
 * Schema_meta row contents per the embedding contract §3. Field types are
 * intentionally widened (string/number) so callers can READ foreign DBs
 * and detect contract drift at runtime — narrow literals would make the
 * mismatch checks tautological at the type level.
 */
export interface SchemaMeta {
  schemaVersion: string;
  model: string;
  vectorDim: number;
  vectorDtype: string;
  chunkerMaxChars: number;
  chunkerOverlap: number;
  writer: string;
  writerVersion: string;
}

/** Result of a unified retrieval query. */
export interface QueryResult {
  path: string;
  chunk: number;
  title: string | null;
  source: string | null;
  doctrine: string | null;
  score: Score;
  text: string;
  /** Tagged in unified results so the UI can render the source DB. */
  sourceDb?: 'self' | 'corpus';
}

/** Result of an idempotent index build. */
export interface BuildResult {
  notesProcessed: number;
  chunksAdded: number;
  chunksSkipped: number;
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
}
