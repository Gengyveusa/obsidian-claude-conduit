import { describe, expect, it } from 'vitest';

import { analyzeMocShape, looksLikeMoc } from '../../src/organization/MocDetection';

describe('looksLikeMoc', () => {
  it('returns true for a textbook MOC (heading + 3+ bullet wikilinks, high density)', () => {
    const content = `# Decisions

- [[ADR-001 Some choice]]
- [[ADR-002 Another]]
- [[ADR-003 A third]]`;
    expect(looksLikeMoc(content)).toBe(true);
  });

  it('returns true with asterisk bullets', () => {
    const content = `## Topics

* [[A]]
* [[B]]
* [[C]]`;
    expect(looksLikeMoc(content)).toBe(true);
  });

  it('returns true with numbered bullets', () => {
    const content = `# Order

1. [[First]]
2. [[Second]]
3. [[Third]]
4. [[Fourth]]`;
    expect(looksLikeMoc(content)).toBe(true);
  });

  it('accepts bullets with trailing prose', () => {
    const content = `# Decisions

- [[ADR-001]] — landed last sprint
- [[ADR-002]] — pending review
- [[ADR-003]] — still drafting`;
    expect(looksLikeMoc(content)).toBe(true);
  });

  it('returns false when there is no heading', () => {
    const content = `- [[A]]
- [[B]]
- [[C]]`;
    expect(looksLikeMoc(content)).toBe(false);
  });

  it('returns false when there are fewer than 3 wikilink bullets', () => {
    const content = `# Notes

- [[only-one]]
- [[and-another]]`;
    expect(looksLikeMoc(content)).toBe(false);
  });

  it('returns false on a regular note with prose + a couple of inline links', () => {
    const content = `# Meeting Notes

Met with the team to talk about [[Pipeline_State]] and the upcoming
deliverables. Sarah mentioned [[Soltura]] in passing. We didn't get to
talk about [[Hangar]] yet.

Action items will be tracked in the usual place.`;
    expect(looksLikeMoc(content)).toBe(false);
  });

  it('returns false when wikilink-bullet density falls below 30%', () => {
    // 3 wikilink bullets but the body is mostly prose around them.
    const content = `# Topic

Some prose here.
More prose.
And even more prose.
Plus one more line of context.
And one more.
Yet more context.
And so on.

- [[A]]
- [[B]]
- [[C]]`;
    expect(looksLikeMoc(content)).toBe(false);
  });

  it('ignores frontmatter when measuring', () => {
    const content = `---
title: My MOC
tags: [moc]
---
# Index

- [[A]]
- [[B]]
- [[C]]`;
    expect(looksLikeMoc(content)).toBe(true);
  });

  it('handles wikilink with alias', () => {
    const content = `# Aliased

- [[some/path/Note|Display]]
- [[other/Note|Another]]
- [[third|Third]]`;
    expect(looksLikeMoc(content)).toBe(true);
  });
});

describe('analyzeMocShape — full metrics', () => {
  it('returns first heading without the # prefix', () => {
    const result = analyzeMocShape('## My Header\n\n- [[a]]\n- [[b]]\n- [[c]]');
    expect(result.firstHeading).toBe('My Header');
  });

  it("returns null firstHeading when content has no heading", () => {
    expect(analyzeMocShape('plain text').firstHeading).toBeNull();
  });

  it('reports linkDensity rounded to 2 decimals', () => {
    // 3 wikilink-bullets out of 4 non-blank lines (1 heading + 3 bullets) → 0.75
    const result = analyzeMocShape('# h\n- [[a]]\n- [[b]]\n- [[c]]');
    expect(result.linkDensity).toBe(0.75);
  });

  it('counts blank lines as not contributing to bodyLineCount', () => {
    const result = analyzeMocShape('# h\n\n- [[a]]\n\n- [[b]]\n\n- [[c]]\n');
    expect(result.bodyLineCount).toBe(4); // 1 heading + 3 bullets, NO blank lines
  });

  it('returns wikilinkBulletCount === 0 when no list items contain wikilinks', () => {
    const result = analyzeMocShape('# h\n- one\n- two\n- three');
    expect(result.wikilinkBulletCount).toBe(0);
    expect(result.looksLikeMoc).toBe(false);
  });
});
