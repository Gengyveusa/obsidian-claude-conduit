import initSqlJs, { type Database } from 'sql.js';
import type { Chunk, SchemaMeta } from './types';

/**
 * Embedding-contract constants. Pinned to schema v1 per
 * docs/embed_interface.md §3.
 */
export const SCHEMA_VERSION = '1' as const;
export const MODEL = 'sentence-transformers/all-MiniLM-L6-v2' as const;
export const VECTOR_DIM = 384 as const;
export const VECTOR_DTYPE = 'float32' as const;
export const CHUNKER_MAX_CHARS = 1500 as const;
export const CHUNKER_OVERLAP = 200 as const;
export const WRITER = 'sagittarius' as const;

const REQUIRED_META_KEYS = [
  'schema_version',
  'model',
  'vector_dim',
  'vector_dtype',
  'chunker_max_chars',
  'chunker_overlap',
  'writer',
  'writer_version',
] as const;

export interface SqliteOpenOptions {
  /** Existing database file as a buffer. Pass undefined to create an empty DB. */
  buffer?: Uint8Array;
  /** Plugin version for the schema_meta `writer_version` row. */
  writerVersion: string;
  /**
   * Pre-loaded sql.js wasm as an ArrayBuffer. Production callers pass the
   * esbuild-inlined binary via openEngine.ts; tests omit this and let sql.js
   * find the wasm via filesystem fallback.
   */
  wasmBinary?: ArrayBuffer;
}

/**
 * Wraps a sql.js Database with the Sagittarius schema (chunks + notes +
 * schema_meta) per docs/embed_interface.md §3. Owns one Database instance;
 * not safe for concurrent writers (the contract bans them).
 *
 * @example
 *   const engine = await SqliteEngine.open({ writerVersion: '0.1.0' });
 *   engine.upsertChunk({ notePath: 'a.md', chunkIndex: 0, text: '...', embedding: vec });
 *   const buffer = engine.export();
 *   await app.vault.adapter.writeBinary('.obsidian/plugins/obsidian-claude-conduit/index.sqlite', buffer);
 */
export class SqliteEngine {
  private constructor(private readonly db: Database) {}

  /**
   * Open or create a Sagittarius SQLite database.
   * @example const engine = await SqliteEngine.open({ writerVersion: '0.1.0' });
   */
  static async open(opts: SqliteOpenOptions): Promise<SqliteEngine> {
    const initOpts = opts.wasmBinary ? { wasmBinary: opts.wasmBinary } : {};
    const sql = await initSqlJs(initOpts);
    const db = opts.buffer ? new sql.Database(opts.buffer) : new sql.Database();
    const engine = new SqliteEngine(db);
    engine.migrate(opts.writerVersion);
    return engine;
  }

  /** Initialize the schema and write all required schema_meta rows. Idempotent. */
  private migrate(writerVersion: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        note_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        UNIQUE(note_path, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS idx_path ON chunks(note_path);

      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        title TEXT,
        source TEXT,
        doctrine_alignment TEXT,
        last_modified REAL,
        chunk_count INTEGER
      );

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)',
    );
    const rows: Array<[string, string]> = [
      ['schema_version', SCHEMA_VERSION],
      ['model', MODEL],
      ['vector_dim', String(VECTOR_DIM)],
      ['vector_dtype', VECTOR_DTYPE],
      ['chunker_max_chars', String(CHUNKER_MAX_CHARS)],
      ['chunker_overlap', String(CHUNKER_OVERLAP)],
      ['writer', WRITER],
      ['writer_version', writerVersion],
    ];
    for (const row of rows) {
      stmt.run(row);
    }
    stmt.free();
  }

  /**
   * Read all schema_meta rows. Throws if any required row is missing — that
   * indicates the file was not produced by a v1 contract writer.
   * @example const meta = engine.getSchemaMeta();
   */
  getSchemaMeta(): SchemaMeta {
    const result = this.db.exec('SELECT key, value FROM schema_meta');
    const rows = result[0]?.values ?? [];
    const map = new Map<string, string>();
    for (const row of rows) {
      const k = row[0] as string;
      const v = row[1] as string;
      map.set(k, v);
    }
    for (const k of REQUIRED_META_KEYS) {
      if (!map.has(k)) {
        throw new Error(
          `SqliteEngine: schema_meta is missing required key '${k}'. ` +
            `This database was not produced by a v1 contract writer. ` +
            `Either rebuild it (rm + reindex) or check schema_version compatibility.`,
        );
      }
    }
    return {
      schemaVersion: map.get('schema_version') as '1',
      model: map.get('model') as typeof MODEL,
      vectorDim: Number(map.get('vector_dim')) as 384,
      vectorDtype: map.get('vector_dtype') as 'float32',
      chunkerMaxChars: Number(map.get('chunker_max_chars')) as 1500,
      chunkerOverlap: Number(map.get('chunker_overlap')) as 200,
      writer: map.get('writer') as 'corpus-ingest' | 'sagittarius',
      writerVersion: map.get('writer_version') as string,
    };
  }

  /**
   * Insert or replace a chunk. Embedding must be exactly VECTOR_DIM floats.
   * @example engine.upsertChunk({ notePath: 'a.md', chunkIndex: 0, text: '...', embedding: vec });
   */
  upsertChunk(chunk: Chunk): void {
    if (chunk.embedding.length !== VECTOR_DIM) {
      throw new Error(
        `SqliteEngine.upsertChunk: embedding has ${chunk.embedding.length} dims, ` +
          `expected ${VECTOR_DIM}. Did you encode with the wrong model?`,
      );
    }
    const blob = float32ToLeBytes(chunk.embedding);
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO chunks (note_path, chunk_index, text, embedding) VALUES (?, ?, ?, ?)',
    );
    stmt.run([chunk.notePath, chunk.chunkIndex, chunk.text, blob]);
    stmt.free();
  }

  /**
   * Read a chunk by (notePath, chunkIndex). Returns null if not found.
   * @example const c = engine.getChunk('a.md', 0);
   */
  getChunk(notePath: string, chunkIndex: number): Chunk | null {
    const stmt = this.db.prepare(
      'SELECT note_path, chunk_index, text, embedding FROM chunks WHERE note_path = ? AND chunk_index = ?',
    );
    stmt.bind([notePath, chunkIndex]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.get();
    stmt.free();
    return {
      notePath: row[0] as string,
      chunkIndex: row[1] as number,
      text: row[2] as string,
      embedding: leBytesToFloat32(row[3] as Uint8Array),
    };
  }

  /**
   * Count rows in a known table.
   * @example const n = engine.count('chunks');
   */
  count(table: 'chunks' | 'notes'): number {
    const result = this.db.exec(`SELECT COUNT(*) FROM ${table}`);
    const value = result[0]?.values[0]?.[0];
    if (typeof value !== 'number') {
      throw new Error(`SqliteEngine.count: COUNT(*) returned a non-number for table '${table}'.`);
    }
    return value;
  }

  /**
   * Export the database as a buffer suitable for writing to disk.
   * @example const buf = engine.export(); fs.writeFileSync('index.sqlite', buf);
   */
  export(): Uint8Array {
    return this.db.export();
  }

  /** Close the database and free WASM memory. The engine is unusable after this call. */
  close(): void {
    this.db.close();
  }
}

/**
 * Encode a Float32Array as a Uint8Array of little-endian f32 bytes.
 * 384 floats → 1536 bytes. The contract pins LE per §3 "encoding rules."
 * @example const bytes = float32ToLeBytes(new Float32Array([1.0])); // [0x00, 0x00, 0x80, 0x3F]
 */
export function float32ToLeBytes(vec: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(vec.byteLength);
  const view = new DataView(buf);
  for (let i = 0; i < vec.length; i++) {
    view.setFloat32(i * 4, vec[i], /* littleEndian */ true);
  }
  return new Uint8Array(buf);
}

/**
 * Decode a little-endian f32 byte buffer back into a Float32Array.
 * @example const vec = leBytesToFloat32(blob);
 */
export function leBytesToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  }
  return out;
}
