import { describe, expect, it } from 'vitest';

import {
  RetrievalSimilarityFinder,
  l2Normalize,
  meanPool,
} from '../../src/curator/RetrievalSimilarityFinder';
import type { Chunk } from '../../src/retrieval/types';

function chunk(notePath: string, chunkIndex: number, embedding: number[]): Chunk {
  return {
    notePath,
    chunkIndex,
    text: '',
    embedding: new Float32Array(embedding),
  };
}

function makeSource(chunks: Chunk[]): { allChunks(): Chunk[] } {
  return { allChunks: () => chunks };
}

describe('meanPool', () => {
  it('averages component-wise across vectors of equal dim', () => {
    const out = meanPool([new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])]);
    expect(Array.from(out)).toEqual([0.5, 0.5, 0]);
  });

  it('throws on empty input', () => {
    expect(() => meanPool([])).toThrow(/empty/);
  });

  it('throws on dim mismatch', () => {
    expect(() => meanPool([new Float32Array([1, 0]), new Float32Array([1, 0, 0])])).toThrow(
      /dim mismatch/,
    );
  });
});

describe('l2Normalize', () => {
  it('produces a unit-norm vector', () => {
    const v = l2Normalize(new Float32Array([3, 4]));
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
  });

  it('passes a zero vector through unchanged', () => {
    const v = l2Normalize(new Float32Array([0, 0, 0]));
    expect(Array.from(v)).toEqual([0, 0, 0]);
  });
});

describe('RetrievalSimilarityFinder', () => {
  it('returns empty when the note has no chunks', async () => {
    const finder = new RetrievalSimilarityFinder(makeSource([chunk('a.md', 0, [1, 0])]));
    expect(await finder.findSimilar('missing.md', 3)).toEqual([]);
  });

  it('ranks notes by cosine similarity desc and excludes self', async () => {
    const finder = new RetrievalSimilarityFinder(
      makeSource([
        chunk('a.md', 0, [1, 0, 0]),
        chunk('near.md', 0, [0.9, 0.1, 0]),
        chunk('far.md', 0, [0, 0, 1]),
        chunk('also-near.md', 0, [0.8, 0.2, 0]),
      ]),
    );
    const results = await finder.findSimilar('a.md', 3);
    expect(results.map((r) => r.path)).toEqual(['near.md', 'also-near.md', 'far.md']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
    expect(results.every((r) => r.path !== 'a.md')).toBe(true);
  });

  it('caps at k', async () => {
    const finder = new RetrievalSimilarityFinder(
      makeSource([
        chunk('a.md', 0, [1, 0]),
        chunk('b.md', 0, [1, 0]),
        chunk('c.md', 0, [1, 0]),
        chunk('d.md', 0, [1, 0]),
      ]),
    );
    const results = await finder.findSimilar('a.md', 2);
    expect(results).toHaveLength(2);
  });

  it('mean-pools multi-chunk notes', async () => {
    // a.md is a 50/50 mix; the closer match is the one whose mean is also 50/50.
    const finder = new RetrievalSimilarityFinder(
      makeSource([
        chunk('a.md', 0, [1, 0]),
        chunk('a.md', 1, [0, 1]),
        chunk('mixed.md', 0, [1, 0]),
        chunk('mixed.md', 1, [0, 1]),
        chunk('pure.md', 0, [1, 0]),
      ]),
    );
    const results = await finder.findSimilar('a.md', 2);
    expect(results[0].path).toBe('mixed.md');
    expect(results[0].score).toBeCloseTo(1, 5);
  });

  it('clamps scores into [0, 1]', async () => {
    // Use opposite-direction vectors (cosine = -1, would clamp to 0).
    const finder = new RetrievalSimilarityFinder(
      makeSource([chunk('a.md', 0, [1, 0]), chunk('b.md', 0, [-1, 0])]),
    );
    const [r] = await finder.findSimilar('a.md', 1);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('caches vectors across calls and resets on resetCache', async () => {
    let callCount = 0;
    const source = {
      allChunks(): Chunk[] {
        callCount += 1;
        return [chunk('a.md', 0, [1, 0]), chunk('b.md', 0, [1, 0])];
      },
    };
    const finder = new RetrievalSimilarityFinder(source);
    await finder.findSimilar('a.md', 1);
    await finder.findSimilar('a.md', 1);
    expect(callCount).toBe(1);
    finder.resetCache();
    await finder.findSimilar('a.md', 1);
    expect(callCount).toBe(2);
  });
});
