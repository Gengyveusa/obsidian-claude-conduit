import { describe, expect, it } from 'vitest';

import {
  MISSING_FRONTMATTER_RULE_NAME,
  extractFrontmatterKeys,
  makeMissingFrontmatterRule,
  matchSchema,
} from '../../src/curator/rules/MissingFrontmatterRule';
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
    return Promise.resolve(this.files.get(p) ?? '');
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

describe('extractFrontmatterKeys', () => {
  it('returns empty set when no frontmatter present', () => {
    expect(extractFrontmatterKeys('# Just markdown\nno frontmatter')).toEqual(new Set());
  });

  it('parses top-level keys', () => {
    const fm = `---
title: foo
status: open
date: 2024-01-01
---

body
`;
    expect(extractFrontmatterKeys(fm)).toEqual(new Set(['title', 'status', 'date']));
  });

  it('ignores nested (indented) keys', () => {
    const fm = `---
title: foo
nested:
  child: value
---
`;
    expect(extractFrontmatterKeys(fm)).toEqual(new Set(['title', 'nested']));
  });

  it('handles unclosed frontmatter (returns empty)', () => {
    expect(extractFrontmatterKeys('---\ntitle: foo\nno close\n')).toEqual(new Set());
  });

  it('handles CRLF line endings', () => {
    const fm = '---\r\ntitle: foo\r\nstatus: open\r\n---\r\n';
    expect(extractFrontmatterKeys(fm)).toEqual(new Set(['title', 'status']));
  });
});

describe('matchSchema', () => {
  const entries: ReadonlyArray<readonly [string, string[]]> = [
    ['22-Decisions/sub', ['status', 'date', 'priority']],
    ['22-Decisions', ['status', 'date']],
    ['10-Inbox', ['captured']],
  ];

  it('picks the longest matching prefix', () => {
    expect(matchSchema('22-Decisions/sub/foo.md', entries)?.prefix).toBe('22-Decisions/sub');
  });

  it('falls back to less-specific prefix', () => {
    expect(matchSchema('22-Decisions/foo.md', entries)?.prefix).toBe('22-Decisions');
  });

  it('returns null when no prefix matches', () => {
    expect(matchSchema('99-Other/foo.md', entries)).toBeNull();
  });

  it('returns the schema fields, not just the prefix', () => {
    const m = matchSchema('22-Decisions/foo.md', entries);
    expect(m?.fields).toEqual(['status', 'date']);
  });
});

describe('makeMissingFrontmatterRule', () => {
  it('reports missing fields for notes in matching folders', async () => {
    const corpus = new FakeCorpus();
    corpus.add('22-Decisions/decision.md', '---\ntitle: x\n---\nbody');
    const rule = makeMissingFrontmatterRule({
      schemas: { '22-Decisions': ['status', 'date'] },
    });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleName).toBe(MISSING_FRONTMATTER_RULE_NAME);
    expect(findings[0].payload).toMatchObject({
      missingFields: ['status', 'date'],
      schemaPrefix: '22-Decisions',
    });
  });

  it('passes notes that have all required fields', async () => {
    const corpus = new FakeCorpus();
    corpus.add(
      '22-Decisions/decision.md',
      '---\nstatus: open\ndate: 2024-01-01\nextra: ok\n---\n',
    );
    const rule = makeMissingFrontmatterRule({
      schemas: { '22-Decisions': ['status', 'date'] },
    });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('skips notes outside configured folders', async () => {
    const corpus = new FakeCorpus();
    corpus.add('99-Other/foo.md', ''); // no frontmatter at all
    const rule = makeMissingFrontmatterRule({
      schemas: { '22-Decisions': ['status'] },
    });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('returns empty when no schemas configured', async () => {
    const corpus = new FakeCorpus();
    corpus.add('22-Decisions/x.md', '---\n---\n');
    const rule = makeMissingFrontmatterRule({ schemas: {} });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('flags notes with no frontmatter at all', async () => {
    const corpus = new FakeCorpus();
    corpus.add('22-Decisions/bare.md', 'just body, no frontmatter');
    const rule = makeMissingFrontmatterRule({
      schemas: { '22-Decisions': ['status'] },
    });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].payload).toMatchObject({ missingFields: ['status'] });
  });

  it('severity is fixed at 0.55', async () => {
    const corpus = new FakeCorpus();
    corpus.add('22-Decisions/x.md', '');
    const rule = makeMissingFrontmatterRule({
      schemas: { '22-Decisions': ['status'] },
    });
    const findings = await rule.detect(corpus);
    expect(findings[0].severity).toBe(0.55);
  });
});
