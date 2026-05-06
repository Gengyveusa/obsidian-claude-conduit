/**
 * Cross-engine acceptance test for ADR-011's central bet: a database
 * produced by sql.js must be readable by *another* SQLite engine without
 * any conversion. We use the system `sqlite3` CLI (preinstalled on
 * GHA's ubuntu-latest runner) so this test catches not just sql.js bugs
 * but also any encoding drift between sql.js and corpus-ingest's Python
 * `sqlite3` (which sits on the same SQLite v3 family).
 *
 * If this test fails, ADR-011's escape hatch (revisit in Phase 5) is
 * needed sooner — read the failure and surface to Thad.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  SqliteEngine,
  VECTOR_DIM,
  float32ToLeBytes,
} from '../../src/retrieval/SqliteEngine';

let workDir: string;

function sqliteAvailable(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  if (!sqliteAvailable()) {
    // Surface a clear error so CI failures are diagnosable.
    throw new Error(
      'byte-identical.spec.ts requires the `sqlite3` CLI on PATH. ' +
        "Install with `apt-get install sqlite3` or skip this suite via vitest's `--exclude` flag.",
    );
  }
});

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function freshDbPath(): string {
  workDir = mkdtempSync(join(tmpdir(), 'sagittarius-byteid-'));
  return join(workDir, 'index.sqlite');
}

function sqlite(dbPath: string, sql: string, ...args: string[]): string {
  return execFileSync('sqlite3', [dbPath, sql, ...args], { encoding: 'utf8' }).trim();
}

describe('SqliteEngine produces files readable by the system `sqlite3` CLI', () => {
  it('opens with the SQLite v3 magic header at byte 0', async () => {
    const engine = await SqliteEngine.open({ writerVersion: 'test-0.0.1' });
    const buf = engine.export();
    engine.close();

    // ASCII for "SQLite format 3\0"
    const expected = new Uint8Array([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
    ]);
    expect(Array.from(buf.slice(0, 16))).toEqual(Array.from(expected));
  });

  it('exposes all required schema_meta rows to the sqlite3 CLI', async () => {
    const engine = await SqliteEngine.open({ writerVersion: 'test-0.0.1' });
    const buf = engine.export();
    engine.close();

    const dbPath = freshDbPath();
    writeFileSync(dbPath, buf);

    const out = sqlite(dbPath, 'SELECT key || "=" || value FROM schema_meta ORDER BY key');
    const lines = out.split('\n').sort();

    expect(lines).toEqual(
      [
        'chunker_max_chars=1500',
        'chunker_overlap=200',
        'model=sentence-transformers/all-MiniLM-L6-v2',
        'schema_version=1',
        'vector_dim=384',
        'vector_dtype=float32',
        'writer=sagittarius',
        'writer_version=test-0.0.1',
      ].sort(),
    );
  });

  it('preserves chunk text + BLOB bytes exactly through sql.js → file → sqlite3 CLI', async () => {
    const engine = await SqliteEngine.open({ writerVersion: 'test' });
    const vec = new Float32Array(VECTOR_DIM);
    for (let i = 0; i < VECTOR_DIM; i++) {
      vec[i] = (i % 7) * 0.125 - 0.5;
    }
    engine.upsertChunk({
      notePath: '50-FortressFlow/Pipeline_State.md',
      chunkIndex: 0,
      text: '14/16 SENT as of last sweep.',
      embedding: vec,
    });
    const buf = engine.export();
    engine.close();

    const dbPath = freshDbPath();
    writeFileSync(dbPath, buf);

    // 1. row count
    expect(sqlite(dbPath, 'SELECT COUNT(*) FROM chunks')).toBe('1');

    // 2. text and path roundtrip cleanly
    expect(
      sqlite(
        dbPath,
        "SELECT note_path || '|' || chunk_index || '|' || text FROM chunks",
      ),
    ).toBe('50-FortressFlow/Pipeline_State.md|0|14/16 SENT as of last sweep.');

    // 3. BLOB is byte-identical to our LE-f32 encoding
    const blobHex = sqlite(
      dbPath,
      "SELECT lower(hex(embedding)) FROM chunks WHERE note_path = '50-FortressFlow/Pipeline_State.md'",
    );
    const expectedHex = Array.from(float32ToLeBytes(vec))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(blobHex).toBe(expectedHex);
    expect(blobHex.length).toBe(VECTOR_DIM * 4 * 2); // 1536 bytes × 2 hex chars each
  });

  it('survives sql.js → file → sqlite3 CLI → reopen by sql.js (full triangle)', async () => {
    const engine1 = await SqliteEngine.open({ writerVersion: 'test' });
    // 0.5 is exactly representable in IEEE 754 f32; 0.42 isn't.
    const vec = new Float32Array(VECTOR_DIM).fill(0.5);
    engine1.upsertChunk({
      notePath: '70-Memory/people/harold-wallace.md',
      chunkIndex: 3,
      text: 'last touch: 2026-04-12',
      embedding: vec,
    });
    const buf = engine1.export();
    engine1.close();

    const dbPath = freshDbPath();
    writeFileSync(dbPath, buf);

    // Add a row via the system CLI to prove bidirectional compatibility.
    // Use a 1-byte BLOB: VECTOR_DIM-strict reads will skip this row, but the
    // file remains a valid SQLite v3 that sql.js can reopen.
    sqlite(
      dbPath,
      "INSERT INTO chunks (note_path, chunk_index, text, embedding) VALUES ('cli-added.md', 0, 'from cli', x'00')",
    );

    // Reload via raw fs — same path Sagittarius's vault adapter takes.
    const reloaded = await SqliteEngine.open({
      buffer: new Uint8Array(readFileSync(dbPath)),
      writerVersion: 'test',
    });
    expect(reloaded.count('chunks')).toBe(2);
    const c = reloaded.getChunk('70-Memory/people/harold-wallace.md', 3);
    expect(c?.text).toBe('last touch: 2026-04-12');
    expect(c?.embedding[0]).toBe(0.5);
    reloaded.close();
  });
});
