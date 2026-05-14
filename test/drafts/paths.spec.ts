import { describe, expect, it } from 'vitest';

import {
  DRAFTS_ROOT,
  draftPathFor,
  draftPathWithSuffix,
  isDraftPath,
  promotedPathFor,
  slugifyTopic,
} from '../../src/drafts/paths';

describe('slugifyTopic', () => {
  it('lowercases and dasherizes a multi-word topic', () => {
    expect(slugifyTopic('Q3 Roadmap Synthesis')).toBe('q3-roadmap-synthesis');
  });

  it('collapses runs of non-alphanumeric chars', () => {
    expect(slugifyTopic('hello!!! @world  --  foo')).toBe('hello-world-foo');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyTopic('---bar---')).toBe('bar');
  });

  it('returns "untitled" for empty or punctuation-only input', () => {
    expect(slugifyTopic('')).toBe('untitled');
    expect(slugifyTopic('!!!')).toBe('untitled');
    expect(slugifyTopic('   ')).toBe('untitled');
  });

  it('caps to the maxLen and avoids a trailing dash after truncation', () => {
    const slug = slugifyTopic('the quick brown fox jumps over the lazy dog repeatedly today', 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug).not.toMatch(/-$/);
  });
});

describe('draftPathFor', () => {
  it('builds the expected vault-relative path', () => {
    expect(draftPathFor('30-Projects', 'Q3 synthesis')).toBe(
      '_drafts/30-Projects/q3-synthesis.md',
    );
  });

  it('normalizes leading slashes + missing trailing slashes', () => {
    expect(draftPathFor('/30-Projects/', 'X')).toBe('_drafts/30-Projects/x.md');
    expect(draftPathFor('30-Projects', 'X')).toBe('_drafts/30-Projects/x.md');
    expect(draftPathFor('30-Projects/', 'X')).toBe('_drafts/30-Projects/x.md');
  });

  it('handles an empty destination folder (drafts at quarantine root)', () => {
    expect(draftPathFor('', 'standalone')).toBe('_drafts/standalone.md');
  });
});

describe('promotedPathFor', () => {
  it('strips the _drafts/ prefix', () => {
    expect(promotedPathFor('_drafts/30-Projects/q3.md')).toBe('30-Projects/q3.md');
  });

  it('throws when given a non-draft path', () => {
    expect(() => promotedPathFor('30-Projects/q3.md')).toThrow(/not a draft path/);
  });
});

describe('isDraftPath', () => {
  it('is true for paths under _drafts/', () => {
    expect(isDraftPath('_drafts/foo.md')).toBe(true);
    expect(isDraftPath('_drafts/30-Projects/foo.md')).toBe(true);
  });

  it('is false for canonical paths', () => {
    expect(isDraftPath('30-Projects/foo.md')).toBe(false);
    expect(isDraftPath('foo.md')).toBe(false);
  });

  it('quarantine root constant matches the prefix', () => {
    expect(DRAFTS_ROOT).toBe('_drafts/');
  });
});

describe('draftPathWithSuffix', () => {
  it('returns the base path for attempt < 2', () => {
    expect(draftPathWithSuffix('_drafts/x/foo.md', 1)).toBe('_drafts/x/foo.md');
  });

  it('appends a numeric suffix before the extension', () => {
    expect(draftPathWithSuffix('_drafts/x/foo.md', 2)).toBe('_drafts/x/foo-2.md');
    expect(draftPathWithSuffix('_drafts/x/foo.md', 7)).toBe('_drafts/x/foo-7.md');
  });

  it('appends a suffix when no extension is present', () => {
    expect(draftPathWithSuffix('_drafts/x/foo', 3)).toBe('_drafts/x/foo-3');
  });
});
