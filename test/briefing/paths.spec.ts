import { describe, expect, it } from 'vitest';

import {
  BRIEFINGS_ROOT,
  briefingDateFor,
  briefingPathFor,
  isBriefingPath,
} from '../../src/briefing/paths';

describe('briefingPathFor', () => {
  it('computes a YYYY-MM-DD.md path under _briefings/', () => {
    const date = new Date('2026-05-16T07:30:00-07:00');
    expect(briefingPathFor(date, 'America/Los_Angeles')).toBe('_briefings/2026-05-16.md');
  });

  it("respects the operator's timezone (midnight crossing)", () => {
    const date = new Date('2026-05-17T03:00:00Z');
    expect(briefingPathFor(date, 'America/Los_Angeles')).toBe('_briefings/2026-05-16.md');
    expect(briefingPathFor(date, 'UTC')).toBe('_briefings/2026-05-17.md');
  });
});

describe('isBriefingPath', () => {
  it('accepts canonical briefing paths', () => {
    expect(isBriefingPath('_briefings/2026-05-16.md')).toBe(true);
  });
  it('rejects non-_briefings paths', () => {
    expect(isBriefingPath('briefings/2026-05-16.md')).toBe(false);
    expect(isBriefingPath('10-Inbox/2026-05-16.md')).toBe(false);
  });
  it('rejects _archive/ subfolder', () => {
    expect(isBriefingPath('_briefings/_archive/2026-05-01.md')).toBe(false);
  });
  it('rejects malformed filenames', () => {
    expect(isBriefingPath('_briefings/notes.md')).toBe(false);
    expect(isBriefingPath('_briefings/2026-5-16.md')).toBe(false);
  });
  it('exports the root prefix constant', () => {
    expect(BRIEFINGS_ROOT).toBe('_briefings/');
  });
});

describe('briefingDateFor', () => {
  it('extracts the YYYY-MM-DD from a valid briefing path', () => {
    expect(briefingDateFor('_briefings/2026-05-16.md')).toBe('2026-05-16');
  });
  it('returns null for non-briefing paths', () => {
    expect(briefingDateFor('10-Inbox/2026-05-16.md')).toBeNull();
    expect(briefingDateFor('_briefings/_archive/2026-05-01.md')).toBeNull();
  });
});
