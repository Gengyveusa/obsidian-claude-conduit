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
 * The required `schema_meta` rows per the embedding contract §3. Both
 * `corpus-ingest` (Python) and Sagittarius write this table on every build.
 * Reading a DB without all of these rows is a contract violation.
 */
export interface SchemaMeta {
  schemaVersion: '1';
  model: 'sentence-transformers/all-MiniLM-L6-v2';
  vectorDim: 384;
  vectorDtype: 'float32';
  chunkerMaxChars: 1500;
  chunkerOverlap: 200;
  writer: 'corpus-ingest' | 'sagittarius';
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
