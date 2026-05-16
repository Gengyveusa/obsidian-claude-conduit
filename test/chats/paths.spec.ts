import { describe, expect, it } from 'vitest';

import {
  CHATS_ROOT,
  chatNotePathFor,
  chatPathWithSuffix,
  isChatNotePath,
  slugifyChat,
} from '../../src/chats/paths';

describe('slugifyChat', () => {
  it('lowercases + dasherizes a free-text label', () => {
    expect(slugifyChat('What is the Q3 strategy for FortressFlow?')).toBe(
      'what-is-the-q3-strategy-for-fortressflow',
    );
  });

  it('returns "untitled" for empty / punctuation-only input', () => {
    expect(slugifyChat('')).toBe('untitled');
    expect(slugifyChat('!!!???')).toBe('untitled');
  });

  it('caps at maxLen and avoids trailing dash', () => {
    const slug = slugifyChat('the quick brown fox jumps over the lazy dog repeatedly today', 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug).not.toMatch(/-$/);
  });
});

describe('chatNotePathFor', () => {
  it('returns _chats/<date>/<slug>.md', () => {
    const date = new Date('2026-05-16T22:30:00-07:00');
    expect(chatNotePathFor(date, 'America/Los_Angeles', 'q3-strategy')).toBe(
      '_chats/2026-05-16/q3-strategy.md',
    );
  });

  it("respects the operator's timezone", () => {
    const date = new Date('2026-05-17T03:00:00Z'); // = 2026-05-16 in LA
    expect(chatNotePathFor(date, 'America/Los_Angeles', 's')).toBe('_chats/2026-05-16/s.md');
    expect(chatNotePathFor(date, 'UTC', 's')).toBe('_chats/2026-05-17/s.md');
  });
});

describe('isChatNotePath', () => {
  it('accepts canonical paths', () => {
    expect(isChatNotePath('_chats/2026-05-16/q3.md')).toBe(true);
    expect(isChatNotePath('_chats/2026-05-16/long-slug-name.md')).toBe(true);
  });

  it('rejects non-_chats/ paths', () => {
    expect(isChatNotePath('chats/2026-05-16/q3.md')).toBe(false);
    expect(isChatNotePath('10-Inbox/note.md')).toBe(false);
  });

  it('rejects _archive/ subfolder', () => {
    expect(isChatNotePath('_chats/_archive/old.md')).toBe(false);
  });

  it('rejects malformed paths', () => {
    expect(isChatNotePath('_chats/2026-5-16/q3.md')).toBe(false); // not zero-padded
    expect(isChatNotePath('_chats/2026-05-16/q3.txt')).toBe(false); // wrong ext
    expect(isChatNotePath('_chats/q3.md')).toBe(false); // missing date folder
    expect(isChatNotePath('_chats/2026-05-16/-bad.md')).toBe(false); // bad slug start
  });

  it('exports the root prefix as a stable constant', () => {
    expect(CHATS_ROOT).toBe('_chats/');
  });
});

describe('chatPathWithSuffix', () => {
  it('returns the base path for attempt < 2', () => {
    expect(chatPathWithSuffix('_chats/2026-05-16/q3.md', 1)).toBe('_chats/2026-05-16/q3.md');
  });

  it('appends a numeric suffix before the extension', () => {
    expect(chatPathWithSuffix('_chats/2026-05-16/q3.md', 2)).toBe('_chats/2026-05-16/q3-2.md');
    expect(chatPathWithSuffix('_chats/2026-05-16/q3.md', 7)).toBe('_chats/2026-05-16/q3-7.md');
  });
});
