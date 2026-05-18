import { describe, expect, it } from 'vitest';

import { SqliteEngine, VECTOR_DIM } from '../../src/retrieval/SqliteEngine';

/**
 * Phase 16 (v2.0.0) — performance smoke per ADR-037 session 3.
 *
 * Not a benchmark — we don't measure ms ceilings (CI variance makes
 * that flaky). Instead we assert:
 *
 *   1. A populated index with multiple snapshots stays correct under
 *      large row counts (the schema rebuild + partial unique indexes
 *      handle the multi-snapshot case without collision).
 *   2. `allChunks` + `listSnapshotShas` + `deleteChunksForCommit` do
 *      not regress (each completes in well under the 10s vitest
 *      default), keeping us out of "the GC is unusable" territory.
 *
 * Scale: 200 notes × 10 chunks × 3 snapshots = 6000 chunk rows plus
 * 2000 current-state rows = 8000 total. Roughly a medium vault's
 * worth — large enough to stress the schema, small enough not to
 * dominate CI runtime.
 */

const NOTES = 200;
const CHUNKS_PER_NOTE = 10;
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

function makeVec(seed: number): Float32Array {
  const v = new Float32Array(VECTOR_DIM);
  for (let i = 0; i < VECTOR_DIM; i++) {
    v[i] = Math.sin((i + seed) / 13);
  }
  return v;
}

describe('Snapshot scale smoke (Phase 16 / ADR-037)', () => {
  it('handles a medium-scale multi-snapshot index without errors', async () => {
    const engine = await SqliteEngine.open({ writerVersion: 'perf' });

    const vec = makeVec(0);

    // Current state.
    for (let n = 0; n < NOTES; n++) {
      for (let c = 0; c < CHUNKS_PER_NOTE; c++) {
        engine.upsertChunk({
          notePath: `notes/${n}.md`,
          chunkIndex: c,
          text: `current note ${n} chunk ${c}`,
          embedding: vec,
        });
      }
    }
    expect(engine.count('chunks')).toBe(NOTES * CHUNKS_PER_NOTE);

    // Three snapshots — same (path, idx) but different commit_sha.
    for (const sha of [SHA1, SHA2, SHA3]) {
      for (let n = 0; n < NOTES; n++) {
        for (let c = 0; c < CHUNKS_PER_NOTE; c++) {
          engine.upsertChunk({
            notePath: `notes/${n}.md`,
            chunkIndex: c,
            text: `${sha.slice(0, 6)} note ${n} chunk ${c}`,
            embedding: vec,
            commitSha: sha,
          });
        }
      }
    }

    expect(engine.count('chunks')).toBe(NOTES * CHUNKS_PER_NOTE * 4); // 1 current + 3 snapshots

    // Snapshot enumeration honors per-sha grouping.
    const list = engine.listSnapshotShas();
    expect(list).toHaveLength(3);
    expect(list.every((s) => s.chunkCount === NOTES * CHUNKS_PER_NOTE)).toBe(true);

    // Scoped reads return only the requested snapshot.
    const sha2Rows = engine.allChunks({ commitSha: SHA2 });
    expect(sha2Rows).toHaveLength(NOTES * CHUNKS_PER_NOTE);
    expect(sha2Rows.every((r) => r.commitSha === SHA2)).toBe(true);

    // Current-state reads (default allChunks) ignore snapshots.
    expect(engine.allChunks()).toHaveLength(NOTES * CHUNKS_PER_NOTE);

    // GC of a single snapshot removes only its rows.
    const removed = engine.deleteChunksForCommit(SHA1);
    expect(removed).toBe(NOTES * CHUNKS_PER_NOTE);
    expect(engine.listSnapshotShas().map((s) => s.commitSha)).toEqual([SHA2, SHA3]);
    expect(engine.allChunks({ commitSha: SHA1 })).toHaveLength(0);

    // Export/reopen survives the populated state — the migration
    // path is idempotent at scale.
    const buf = engine.export();
    engine.close();

    const engine2 = await SqliteEngine.open({ buffer: buf, writerVersion: 'perf' });
    expect(engine2.count('chunks')).toBe(NOTES * CHUNKS_PER_NOTE * 3); // current + 2 snapshots
    expect(engine2.listSnapshotShas()).toHaveLength(2);
    engine2.close();
  });
});
