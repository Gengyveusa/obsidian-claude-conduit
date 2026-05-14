import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_CANDIDATE_RULE_NAME,
  type LlmJudge,
  type SimilarityFinder,
  makeDuplicateCandidateRule,
  severityFromSimilarity,
} from '../../src/curator/rules/DuplicateCandidateRule';
import type { CorpusStat, CuratorCorpus } from '../../src/curator/types';

class FakeCorpus implements CuratorCorpus {
  files: Map<string, string> = new Map();
  add(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
  read(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) {
      return Promise.reject(new Error(`not found: ${p}`));
    }
    return Promise.resolve(c);
  }
  stat(): Promise<CorpusStat | null> {
    return Promise.resolve(null);
  }
  outboundLinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
  backlinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

class FakeFinder implements SimilarityFinder {
  constructor(
    private readonly pairs: Record<string, Array<{ path: string; score: number }>>,
  ) {}
  findSimilar(notePath: string): Promise<Array<{ path: string; score: number }>> {
    return Promise.resolve(this.pairs[notePath] ?? []);
  }
}

interface RecordedCall {
  a: string;
  b: string;
}

function makeJudge(
  decision: (a: string, b: string) => boolean,
): LlmJudge & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    judge: (a, b) => {
      calls.push({ a: a.path, b: b.path });
      return Promise.resolve(decision(a.path, b.path));
    },
  };
}

describe('severityFromSimilarity', () => {
  it('caps at 0.5..0.8 range', () => {
    expect(severityFromSimilarity(0)).toBe(0.5);
    expect(severityFromSimilarity(1)).toBe(0.8);
    expect(severityFromSimilarity(0.5)).toBe(0.65);
  });
  it('clamps out-of-range values', () => {
    expect(severityFromSimilarity(-0.5)).toBe(0.5);
    expect(severityFromSimilarity(2)).toBe(0.8);
  });
});

describe('makeDuplicateCandidateRule', () => {
  it('produces a finding for an LLM-confirmed similar pair', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', 'about cats')
      .add('b.md', 'also about cats');
    const finder = new FakeFinder({
      'a.md': [{ path: 'b.md', score: 0.92 }],
      'b.md': [{ path: 'a.md', score: 0.92 }],
    });
    const judge = makeJudge(() => true);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
    });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleName).toBe(DUPLICATE_CANDIDATE_RULE_NAME);
    expect(findings[0].payload).toMatchObject({
      otherPath: 'b.md',
      similarity: 0.92,
    });
    // Dedup: judge was called once for the pair, not twice.
    expect(judge.calls).toHaveLength(1);
  });

  it('drops pairs below the threshold without calling the judge', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '')
      .add('b.md', '');
    const finder = new FakeFinder({
      'a.md': [{ path: 'b.md', score: 0.7 }],
    });
    const judge = makeJudge(() => true);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
      threshold: 0.85,
    });
    expect(await rule.detect(corpus)).toEqual([]);
    expect(judge.calls).toHaveLength(0);
  });

  it('skips a pair when the judge says "not duplicates"', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '')
      .add('b.md', '');
    const finder = new FakeFinder({
      'a.md': [{ path: 'b.md', score: 0.95 }],
    });
    const judge = makeJudge(() => false);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
    });
    expect(await rule.detect(corpus)).toEqual([]);
    expect(judge.calls).toHaveLength(1);
  });

  it('respects maxLlmCalls budget across many pairs', async () => {
    const corpus = new FakeCorpus();
    const finderMap: Record<string, Array<{ path: string; score: number }>> = {};
    for (let i = 0; i < 10; i += 1) {
      corpus.add(`n${i}.md`, '');
    }
    // Make every note "similar" to the next — 10 pairs, all 0.9.
    for (let i = 0; i < 9; i += 1) {
      finderMap[`n${i}.md`] = [{ path: `n${i + 1}.md`, score: 0.9 }];
    }
    const finder = new FakeFinder(finderMap);
    const judge = makeJudge(() => true);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
      maxLlmCalls: 3,
    });
    const findings = await rule.detect(corpus);
    expect(judge.calls).toHaveLength(3);
    expect(findings).toHaveLength(3);
  });

  it('treats judge errors as "not duplicates" (false-negative bias)', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '')
      .add('b.md', '');
    const finder = new FakeFinder({
      'a.md': [{ path: 'b.md', score: 0.9 }],
    });
    const judge: LlmJudge = {
      judge: () => Promise.reject(new Error('rate limit')),
    };
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
    });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('survives a similarityFinder throw on one note (skips it)', async () => {
    const corpus = new FakeCorpus()
      .add('broken.md', '')
      .add('a.md', '')
      .add('b.md', '');
    const finder: SimilarityFinder = {
      findSimilar: (notePath) => {
        if (notePath === 'broken.md') {
          return Promise.reject(new Error('embedding miss'));
        }
        return Promise.resolve([{ path: 'b.md', score: 0.95 }]);
      },
    };
    const judge = makeJudge(() => true);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
    });
    const findings = await rule.detect(corpus);
    // Only the a.md → b.md pair gets through.
    expect(findings).toHaveLength(1);
  });

  it('orders pairs by similarity desc so the budget keeps the strongest', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '')
      .add('b.md', '')
      .add('c.md', '')
      .add('d.md', '');
    // a-b: 0.9 (highest), a-c: 0.95 (highest), a-d: 0.88 (lowest above threshold).
    const finder = new FakeFinder({
      'a.md': [
        { path: 'b.md', score: 0.9 },
        { path: 'c.md', score: 0.95 },
        { path: 'd.md', score: 0.88 },
      ],
    });
    const judge = makeJudge(() => true);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
      maxLlmCalls: 1,
    });
    const findings = await rule.detect(corpus);
    // Should keep the 0.95 pair, not 0.9 or 0.88.
    expect(findings).toHaveLength(1);
    expect(findings[0].payload).toMatchObject({ otherPath: 'c.md', similarity: 0.95 });
  });

  it('records pairs alphabetically (otherPath > notePath)', async () => {
    const corpus = new FakeCorpus().add('z.md', '').add('a.md', '');
    const finder = new FakeFinder({
      'z.md': [{ path: 'a.md', score: 0.95 }],
    });
    const judge = makeJudge(() => true);
    const rule = makeDuplicateCandidateRule({
      similarityFinder: finder,
      llmJudge: judge,
    });
    const findings = await rule.detect(corpus);
    expect(findings[0].notePath).toBe('a.md');
    expect(findings[0].payload).toMatchObject({ otherPath: 'z.md' });
  });
});
