import { describe, expect, it } from 'vitest';

import {
  TAG_NORMALIZE_RULE_NAME,
  clusterTags,
  editDistance,
  enumerateTags,
  extractTags,
  makeTagNormalizeRule,
  severityFromClusterSize,
  type TagNormalizeLlmJudge,
} from '../../src/curator/rules/TagNormalizeRule';
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

function makeJudge(
  decision: (cluster: string[]) => string | null,
): TagNormalizeLlmJudge & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    judge: (c) => {
      calls.push([...c]);
      return Promise.resolve(decision(c));
    },
  };
}

describe('editDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(editDistance('foo', 'foo')).toBe(0);
  });
  it('returns length for empty other side', () => {
    expect(editDistance('', 'foo')).toBe(3);
    expect(editDistance('foo', '')).toBe(3);
  });
  it('counts insertions, deletions, substitutions', () => {
    expect(editDistance('project', 'projects')).toBe(1);
    expect(editDistance('cat', 'bat')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('clusterTags', () => {
  it('joins tags within edit distance', () => {
    const clusters = clusterTags(['project', 'projects', 'design'], 2);
    expect(clusters).toEqual([['design'], ['project', 'projects']]);
  });
  it('lowercases before clustering', () => {
    const clusters = clusterTags(['Project', 'PROJECT', 'project'], 2);
    expect(clusters).toEqual([['project']]);
  });
  it('keeps far-apart tags in separate clusters', () => {
    const clusters = clusterTags(['cat', 'dog', 'fish'], 1);
    expect(clusters).toEqual([['cat'], ['dog'], ['fish']]);
  });
});

describe('extractTags', () => {
  it('finds inline #tags', () => {
    expect(extractTags('hello #foo and #bar-baz').sort()).toEqual(['bar-baz', 'foo']);
  });
  it('skips heading lines', () => {
    expect(extractTags('# Heading\n#foo')).toEqual(['foo']);
  });
  it('parses frontmatter array form', () => {
    const fm = `---
tags: [foo, "bar baz", qux]
---
body`;
    expect(extractTags(fm)).toEqual(['foo', 'bar baz', 'qux']);
  });
  it('parses frontmatter scalar form', () => {
    const fm = `---
tags: foo
---`;
    expect(extractTags(fm)).toEqual(['foo']);
  });
  it('parses frontmatter block-list form', () => {
    const fm = `---
tags:
  - foo
  - "bar"
  - baz
---`;
    expect(extractTags(fm)).toEqual(['foo', 'bar', 'baz']);
  });
  it('ignores tags inside code fences', () => {
    const content = '#real\n```\n#fake-in-fence\n```\n#also-real';
    expect(extractTags(content).sort()).toEqual(['also-real', 'real']);
  });
  it('skips pure-number heading-like forms', () => {
    expect(extractTags('see #1 not a tag')).toEqual([]);
  });
});

describe('enumerateTags', () => {
  it('counts occurrences across notes (lowercase)', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '#Project and #Project again')
      .add('b.md', '#project here')
      .add('c.md', '#design only');
    const counts = await enumerateTags(corpus);
    expect(counts.get('project')).toBe(3);
    expect(counts.get('design')).toBe(1);
  });
});

describe('severityFromClusterSize', () => {
  it('starts at 0.45 for size 1 (clamped by caller)', () => {
    expect(severityFromClusterSize(1)).toBe(0.45);
  });
  it('caps at 0.65', () => {
    expect(severityFromClusterSize(100)).toBe(0.65);
  });
});

describe('makeTagNormalizeRule', () => {
  it('produces a finding for an LLM-confirmed cluster', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '#project')
      .add('b.md', '#projects');
    const judge = makeJudge(() => 'project');
    const rule = makeTagNormalizeRule({ llmJudge: judge });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleName).toBe(TAG_NORMALIZE_RULE_NAME);
    expect(findings[0].payload).toMatchObject({
      cluster: ['project', 'projects'],
      canonical: 'project',
      nonCanonicalNoteCount: 1,
    });
  });

  it('drops clusters when the judge says null (different concepts)', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '#cat')
      .add('b.md', '#bat'); // edit distance 1 — clusters together
    const judge = makeJudge(() => null);
    const rule = makeTagNormalizeRule({ llmJudge: judge });
    expect(await rule.detect(corpus)).toEqual([]);
    expect(judge.calls).toHaveLength(1);
  });

  it('drops singleton clusters before reaching the judge', async () => {
    const corpus = new FakeCorpus().add('a.md', '#unique');
    const judge = makeJudge(() => 'unique');
    const rule = makeTagNormalizeRule({ llmJudge: judge });
    expect(await rule.detect(corpus)).toEqual([]);
    expect(judge.calls).toHaveLength(0);
  });

  it('respects maxLlmCalls budget', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 10; i += 1) {
      corpus.add(`n${i}.md`, `#cluster${i}a\n#cluster${i}b`);
    }
    const judge = makeJudge(() => 'pick');
    const rule = makeTagNormalizeRule({ llmJudge: judge, maxLlmCalls: 3 });
    const findings = await rule.detect(corpus);
    expect(judge.calls.length).toBeLessThanOrEqual(3);
    expect(findings).toHaveLength(judge.calls.length);
  });

  it('treats judge throws as "not the same concept"', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '#project')
      .add('b.md', '#projects');
    const judge: TagNormalizeLlmJudge = {
      judge: () => Promise.reject(new Error('rate limit')),
    };
    const rule = makeTagNormalizeRule({ llmJudge: judge });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('ignores configured tags', async () => {
    const corpus = new FakeCorpus()
      .add('a.md', '#daily')
      .add('b.md', '#dailys'); // close enough to cluster with #daily
    const judge = makeJudge(() => 'daily');
    const rule = makeTagNormalizeRule({
      llmJudge: judge,
      ignoredTags: ['daily', 'dailys'],
    });
    expect(await rule.detect(corpus)).toEqual([]);
    expect(judge.calls).toHaveLength(0);
  });
});
