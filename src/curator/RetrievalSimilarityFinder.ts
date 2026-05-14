import type { Chunk } from '../retrieval/types';
import type { SimilarityFinder } from './rules/DuplicateCandidateRule';

/**
 * Phase 7 v1.0.4 — production `SimilarityFinder` backing
 * `DuplicateCandidateRule` per ADR-024 follow-up.
 *
 * Reads all chunk embeddings out of the SQLite index, mean-pools per note
 * (each chunk vector is already L2-normalized by the embedder per
 * `RetrievalLayer.scoreEngine` line 110), L2-normalizes the pool, then
 * scores each candidate by cosine = dot product.
 *
 * The finder is **lazy + cached**: vectors are materialized on the first
 * `findSimilar` call and reused across the sweep. The caller must call
 * `resetCache()` before re-running if the index has changed in between
 * sweeps. The cache makes a sweep of N notes O(N²·dim) over the in-memory
 * matrix instead of O(N²) reads from SQLite.
 *
 * The source dep is the minimal `{ allChunks(): Chunk[] }` shape rather
 * than a `SqliteEngine` so tests can pass a literal without going through
 * sql.js init.
 */
export class RetrievalSimilarityFinder implements SimilarityFinder {
  private noteVectors: Map<string, Float32Array> | null = null;

  constructor(private readonly source: { allChunks(): Chunk[] }) {}

  findSimilar(
    notePath: string,
    k: number,
  ): Promise<Array<{ path: string; score: number }>> {
    const vecs = this.ensureVectors();
    const self = vecs.get(notePath);
    if (self === undefined) {
      return Promise.resolve([]);
    }
    const scored: Array<{ path: string; score: number }> = [];
    for (const [other, vec] of vecs) {
      if (other === notePath) {
        continue;
      }
      scored.push({ path: other, score: clamp01(dot(self, vec)) });
    }
    scored.sort((a, b) => b.score - a.score);
    return Promise.resolve(scored.slice(0, k));
  }

  /** Drop the cached note-vector map so the next call re-reads `allChunks`. */
  resetCache(): void {
    this.noteVectors = null;
  }

  private ensureVectors(): Map<string, Float32Array> {
    if (this.noteVectors !== null) {
      return this.noteVectors;
    }
    const byPath = new Map<string, Float32Array[]>();
    for (const chunk of this.source.allChunks()) {
      const arr = byPath.get(chunk.notePath) ?? [];
      arr.push(chunk.embedding);
      byPath.set(chunk.notePath, arr);
    }
    const result = new Map<string, Float32Array>();
    for (const [path, vecs] of byPath) {
      result.set(path, l2Normalize(meanPool(vecs)));
    }
    this.noteVectors = result;
    return result;
  }
}

/** Mean-pool a non-empty array of equal-dimension Float32Array vectors. Exported for tests. */
export function meanPool(vecs: Float32Array[]): Float32Array {
  if (vecs.length === 0) {
    throw new Error('meanPool: empty input');
  }
  const dim = vecs[0].length;
  const out = new Float32Array(dim);
  for (const v of vecs) {
    if (v.length !== dim) {
      throw new Error(`meanPool: dim mismatch ${v.length} vs ${dim}`);
    }
    for (let i = 0; i < dim; i += 1) {
      out[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i += 1) {
    out[i] /= vecs.length;
  }
  return out;
}

/** L2-normalize a Float32Array. Returns the input unchanged if its norm is 0. Exported for tests. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) {
    sum += v[i] * v[i];
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return v;
  }
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) {
    out[i] = v[i] / norm;
  }
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`dot: dim mismatch ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function clamp01(n: number): number {
  if (n < 0) {
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}
