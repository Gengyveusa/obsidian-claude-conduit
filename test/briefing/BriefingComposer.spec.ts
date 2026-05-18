import { describe, expect, it } from 'vitest';

import type { ActivityEvent } from '../../src/activity/types';
import {
  composeBriefing,
  type BriefingData,
} from '../../src/briefing/BriefingComposer';
import type { CuratorFinding } from '../../src/curator/types';
import type { DraftRecord } from '../../src/drafts/DraftStore';
import type { CascadeResult } from '../../src/memory/MemoryCascade';

function emptyData(over: Partial<BriefingData> = {}): BriefingData {
  return {
    date: '2026-05-16',
    activityYesterday: [],
    curatorFindings: [],
    draftBacklog: [],
    synthesisOpportunities: [],
    memoryState: { cascade: null, recentJournalPaths: [] },
    openThreads: [],
    ...over,
  };
}

function activity(kind: ActivityEvent['kind'], over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'id',
    timestamp: 1747350840000,
    kind,
    ...over,
  } as ActivityEvent;
}

function finding(over: Partial<CuratorFinding> = {}): CuratorFinding {
  return {
    ruleName: 'broken-link',
    notePath: '30-Projects/q3.md',
    severity: 0.85,
    reason: 'Link to non-existent note',
    ...over,
  };
}

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    path: '_drafts/10-Inbox/q3-synthesis.md',
    topic: 'Q3 synthesis',
    draftingModel: 'claude-opus-4-7',
    generatedAt: 1700000000,
    citedChunksCount: 5,
    firstHeading: null,
    sizeBytes: 1500,
    ...over,
  };
}

describe('composeBriefing', () => {
  it('renders all six sections with empty-state messages when no data', () => {
    const result = composeBriefing(emptyData(), { editorialText: null });
    expect(result.hasContent).toBe(false);
    expect(result.content).toContain('# Briefing: 2026-05-16');
    expect(result.content).toContain('## What changed yesterday (0)');
    expect(result.content).toContain('## Curator suggestions (0)');
    expect(result.content).toContain('## Drafting backlog (0)');
    expect(result.content).toContain('## Synthesis opportunities (0)');
    expect(result.content).toContain('## Memory state');
    expect(result.content).toContain('## Open threads from journals (0)');
    expect(result.content).toContain('(nothing to flag)');
    expect(result.itemCounts.total).toBe(0);
  });

  it('renders the editorial blockquote when supplied', () => {
    const result = composeBriefing(emptyData(), {
      editorialText: 'Yesterday you shipped v1.6.0. Today: focus on Phase 14.',
    });
    expect(result.content).toContain(
      '> Yesterday you shipped v1.6.0. Today: focus on Phase 14.',
    );
  });

  it('omits the editorial section when text is null', () => {
    const result = composeBriefing(emptyData(), { editorialText: null });
    expect(result.content).not.toContain('> ');
  });

  it('renders curator findings severity-sorted desc with severity icons', () => {
    const result = composeBriefing(
      emptyData({
        curatorFindings: [
          finding({ severity: 0.45, reason: 'r-mid', notePath: 'mid.md' }),
          finding({ severity: 0.9, reason: 'r-top', notePath: 'top.md' }),
          finding({ severity: 0.75, reason: 'r-second', notePath: 'second.md' }),
        ],
      }),
      { editorialText: null },
    );
    // High-severity heading shows correct counts.
    expect(result.content).toContain('Curator suggestions ⚠ (2 high, 3 total)');
    // Order: 0.9 > 0.75 > 0.45. Use unique notePath markers to avoid
    // collisions with the heading text ("3 total" matches /high/).
    const idxTop = result.content.indexOf('top.md');
    const idxSecond = result.content.indexOf('second.md');
    const idxMid = result.content.indexOf('mid.md');
    expect(idxTop).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxMid);
    // Severity icons present.
    expect(result.content).toContain('🔴');
    expect(result.content).toContain('🟠');
    expect(result.content).toContain('🟡');
  });

  it('caps items per section at maxItemsPerSection and shows + N more', () => {
    const findings = Array.from({ length: 15 }, (_, i) =>
      finding({ severity: 0.5, reason: `r${i}`, notePath: `n${i}.md` }),
    );
    const result = composeBriefing(emptyData({ curatorFindings: findings }), {
      editorialText: null,
      maxItemsPerSection: 5,
    });
    expect(result.content).toContain('_+ 10 more');
    // 15 still reported in the heading.
    expect(result.content).toContain('(0 high, 15 total)');
  });

  it('renders draft backlog newest-first with title fallback', () => {
    const result = composeBriefing(
      emptyData({
        draftBacklog: [
          draft({ path: '_drafts/a.md', topic: 'Older', generatedAt: 1000 }),
          draft({ path: '_drafts/b.md', topic: 'Newer', generatedAt: 2000 }),
        ],
      }),
      { editorialText: null },
    );
    const idxNewer = result.content.indexOf('Newer');
    const idxOlder = result.content.indexOf('Older');
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it('falls back to firstHeading then path when topic is missing', () => {
    const result = composeBriefing(
      emptyData({
        draftBacklog: [
          draft({ path: '_drafts/no-topic.md', topic: null, firstHeading: 'Heading X', generatedAt: 1 }),
        ],
      }),
      { editorialText: null },
    );
    expect(result.content).toContain('Heading X');
  });

  it('renders synthesis opportunities reading the DraftSuggestionRule payload shape', () => {
    const result = composeBriefing(
      emptyData({
        synthesisOpportunities: [
          finding({
            ruleName: 'draft-suggestion',
            severity: 0.75,
            reason: '15 notes tagged `#q3` lacking synthesis',
            payload: { tag: 'q3', memberCount: 15 },
          }),
        ],
      }),
      { editorialText: null },
    );
    expect(result.content).toContain('`#q3`');
    expect(result.content).toContain('15 notes');
  });

  it('renders memory state — cascade off', () => {
    const result = composeBriefing(emptyData(), { editorialText: null });
    expect(result.content).toContain('Memory cascade: **off**');
  });

  it('renders memory state — cascade enabled with files', () => {
    const cascade: CascadeResult = {
      sections: [
        { path: 'CLAUDE.md', text: 'root rules', truncated: false, sizeBytes: 10 },
        { path: '30-Projects/CLAUDE.md', text: 'project rules', truncated: false, sizeBytes: 14 },
      ],
      totalBytes: 2148,
      budgetHit: false,
    };
    const result = composeBriefing(
      emptyData({
        memoryState: {
          cascade,
          recentJournalPaths: ['_memory/2026-05-15.md', '_memory/2026-05-14.md'],
        },
      }),
      { editorialText: null },
    );
    expect(result.content).toContain('Memory cascade: 2.1KB across 2 file(s)');
    expect(result.content).toContain('`CLAUDE.md`');
    expect(result.content).toContain('`30-Projects/CLAUDE.md`');
    expect(result.content).toContain('_memory/2026-05-15.md');
  });

  it('flags budget hit in memory section', () => {
    const cascade: CascadeResult = {
      sections: [{ path: 'CLAUDE.md', text: 'x', truncated: true, sizeBytes: 100 }],
      totalBytes: 50000,
      budgetHit: true,
    };
    const result = composeBriefing(
      emptyData({ memoryState: { cascade, recentJournalPaths: [] } }),
      { editorialText: null },
    );
    expect(result.content).toContain('budget hit — some content was truncated');
  });

  it('renders open threads from journals', () => {
    const result = composeBriefing(
      emptyData({
        openThreads: [
          'v1.6.0 tag/release pending',
          'Phase 14 implementation',
        ],
      }),
      { editorialText: null },
    );
    expect(result.content).toContain('Open threads from journals (2)');
    expect(result.content).toContain('v1.6.0 tag/release pending');
    expect(result.content).toContain('Phase 14 implementation');
  });

  it('renders activity events newest-first', () => {
    const result = composeBriefing(
      emptyData({
        activityYesterday: [
          activity('write.committed', { timestamp: 1747350000000, id: 'old' }),
          activity('write.committed', { timestamp: 1747353600000, id: 'new' }),
        ],
      }),
      { editorialText: null },
    );
    // Both rendered.
    expect(result.content).toContain('What changed yesterday (2)');
    expect(result.content).toContain('`write.committed`');
  });

  it('hasContent=true when any section is non-empty', () => {
    const result = composeBriefing(
      emptyData({
        curatorFindings: [finding()],
      }),
      { editorialText: null },
    );
    expect(result.hasContent).toBe(true);
    expect(result.itemCounts.curator).toBe(1);
    expect(result.itemCounts.total).toBe(1);
  });
});
