import { describe, expect, it } from 'vitest';

import {
  extractWikilinks,
  isBroken,
  makeBrokenLinkRule,
} from '../../src/curator/rules/BrokenLinkRule';
import type { CuratorCorpus, CorpusStat } from '../../src/curator/types';

class FakeCorpus implements CuratorCorpus {
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }

  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
  read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`not found: ${path}`));
    }
    return Promise.resolve(content);
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

describe('extractWikilinks', () => {
  it('parses plain wikilinks', () => {
    expect(extractWikilinks('see [[Foo]] and [[Bar]]')).toEqual([
      { linkText: '[[Foo]]', target: 'Foo' },
      { linkText: '[[Bar]]', target: 'Bar' },
    ]);
  });

  it('parses aliased wikilinks — keeps target, strips alias', () => {
    expect(extractWikilinks('see [[Foo|the foo]]')).toEqual([
      { linkText: '[[Foo|the foo]]', target: 'Foo' },
    ]);
  });

  it('parses paths with slashes', () => {
    expect(extractWikilinks('[[10-Inbox/Quick-Capture]]')).toEqual([
      { linkText: '[[10-Inbox/Quick-Capture]]', target: '10-Inbox/Quick-Capture' },
    ]);
  });

  it('strips section anchors and block refs', () => {
    expect(extractWikilinks('[[Foo#Section]] [[Bar^block-id]]')).toEqual([
      { linkText: '[[Foo#Section]]', target: 'Foo' },
      { linkText: '[[Bar^block-id]]', target: 'Bar' },
    ]);
  });

  it('skips empty targets and escaped brackets', () => {
    expect(extractWikilinks('[[]] \\[[Escaped]] regular text')).toEqual([]);
  });

  it('finds embeds (treats them as wikilinks)', () => {
    expect(extractWikilinks('![[ImageNote]]')).toEqual([
      { linkText: '[[ImageNote]]', target: 'ImageNote' },
    ]);
  });

  it('returns multiple occurrences of the same target', () => {
    const result = extractWikilinks('[[Foo]] then again [[Foo]]');
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.target === 'Foo')).toBe(true);
  });
});

describe('isBroken', () => {
  const allMd = new Set(['Foo.md', 'sub/Bar.md', 'sub/Bar.md']);
  const basenames = new Map([
    ['Foo.md', 1],
    ['Bar.md', 1],
  ]);

  it('returns false for an exact root match', () => {
    expect(isBroken('Foo', allMd, basenames)).toBe(false);
  });

  it('returns false for a basename match in a subfolder', () => {
    expect(isBroken('Bar', allMd, basenames)).toBe(false);
  });

  it('returns false for a full path that exists', () => {
    expect(isBroken('sub/Bar', allMd, basenames)).toBe(false);
  });

  it('returns true for a target with no match', () => {
    expect(isBroken('Missing', allMd, basenames)).toBe(true);
  });

  it('returns true for a path with slash but wrong location', () => {
    expect(isBroken('other/Bar', allMd, basenames)).toBe(true);
  });
});

describe('makeBrokenLinkRule', () => {
  it('reports findings for broken targets', async () => {
    const rule = makeBrokenLinkRule();
    const corpus = new FakeCorpus({
      'a.md': 'links to [[Foo]] and [[Missing]]',
      'Foo.md': 'I exist',
    });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleName: 'broken-link',
      notePath: 'a.md',
      severity: 0.9,
      payload: { brokenTarget: 'Missing', linkText: '[[Missing]]' },
    });
  });

  it('returns empty when all links resolve', async () => {
    const rule = makeBrokenLinkRule();
    const corpus = new FakeCorpus({
      'a.md': '[[Foo]] [[Bar]]',
      'Foo.md': '',
      'Bar.md': '',
    });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('reports a separate finding per broken occurrence', async () => {
    const rule = makeBrokenLinkRule();
    const corpus = new FakeCorpus({
      'a.md': '[[Gone]] then [[Gone]] again',
    });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(2);
  });

  it('skips a note whose read throws (silently)', async () => {
    const rule = makeBrokenLinkRule();
    const corpus = new FakeCorpus({
      'good.md': '[[Foo]]',
      'Foo.md': '',
    });
    // Inject a path that listAllMarkdown reports but read rejects.
    const broken = new (class extends FakeCorpus {
      override listAllMarkdown(): Promise<string[]> {
        return Promise.resolve(['good.md', 'unreadable.md', 'Foo.md']);
      }
      override read(p: string): Promise<string> {
        if (p === 'unreadable.md') {
          return Promise.reject(new Error('EACCES'));
        }
        return super.read(p);
      }
    })({
      'good.md': '[[Foo]]',
      'Foo.md': '',
    });
    const findings = await rule.detect(broken);
    expect(findings).toEqual([]);
    void corpus;
  });

  it('treats subfolder targets as broken when the exact path is missing', async () => {
    const rule = makeBrokenLinkRule();
    const corpus = new FakeCorpus({
      'a.md': '[[wrong/Path]]',
      'Bar.md': '',
    });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].payload).toMatchObject({ brokenTarget: 'wrong/Path' });
  });
});
