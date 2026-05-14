import { describe, expect, it } from 'vitest';

import { findingToSuggestion } from '../../src/curator/findingToSuggestion';
import type { CuratorFinding } from '../../src/curator/types';

function clock() {
  let n = 1_700_000_000_000;
  return {
    now: () => {
      const v = n;
      n += 1;
      return v;
    },
    randomSuffix: () => 'abc123',
  };
}

describe('findingToSuggestion', () => {
  it('converts a broken-link finding into a BrokenLinkFixSuggestion', () => {
    const finding: CuratorFinding = {
      ruleName: 'broken-link',
      notePath: '10-Inbox/foo.md',
      severity: 0.9,
      reason: 'Links to [[Missing]] but no matching note exists',
      payload: { brokenTarget: 'Missing', linkText: '[[Missing]]' },
    };
    const sug = findingToSuggestion(finding, clock());
    expect(sug).not.toBeNull();
    if (sug === null) {
      return;
    }
    expect(sug.kind).toBe('broken-link-fix');
    expect(sug).toMatchObject({
      kind: 'broken-link-fix',
      notePath: '10-Inbox/foo.md',
      brokenTarget: 'Missing',
      linkText: '[[Missing]]',
      reason: 'Links to [[Missing]] but no matching note exists',
      confidence: 0.9,
    });
    expect(sug.id).toMatch(/^1700000000000-abc123$/);
    expect(sug.createdAt).toBe(1_700_000_000);
  });

  it('converts an orphan finding into an ArchiveStaleSuggestion', () => {
    const finding: CuratorFinding = {
      ruleName: 'orphan',
      notePath: 'forgotten.md',
      severity: 0.55,
      reason: 'No inbound links and last modified 200 day(s) ago',
      payload: { archiveFolder: '_archive/2024', staleDays: 200 },
    };
    const sug = findingToSuggestion(finding, clock());
    expect(sug).not.toBeNull();
    if (sug === null) {
      return;
    }
    expect(sug.kind).toBe('archive-stale');
    expect(sug).toMatchObject({
      kind: 'archive-stale',
      notePath: 'forgotten.md',
      proposedFolder: '_archive/2024',
      staleDays: 200,
      confidence: 0.55,
    });
  });

  it('returns null for an unknown rule name', () => {
    const finding: CuratorFinding = {
      ruleName: 'future-rule',
      notePath: 'a.md',
      severity: 0.5,
      reason: '...',
      payload: { something: 'else' },
    };
    expect(findingToSuggestion(finding, clock())).toBeNull();
  });

  it('returns null when a broken-link finding is missing required payload fields', () => {
    const finding: CuratorFinding = {
      ruleName: 'broken-link',
      notePath: 'a.md',
      severity: 0.9,
      reason: '...',
      payload: { brokenTarget: 'X' }, // missing linkText
    };
    expect(findingToSuggestion(finding, clock())).toBeNull();
  });

  it('returns null when an orphan finding payload is malformed', () => {
    const finding: CuratorFinding = {
      ruleName: 'orphan',
      notePath: 'a.md',
      severity: 0.5,
      reason: '...',
      payload: { staleDays: 'not-a-number' },
    };
    expect(findingToSuggestion(finding, clock())).toBeNull();
  });
});
