import { describe, expect, it } from 'vitest';

import { formatRelative, pathOf, summarize } from '../../src/activity/format';
import type { ActivityEvent } from '../../src/activity/types';

const T = 1_700_000_000_000;

describe('formatRelative', () => {
  it('formats seconds', () => {
    expect(formatRelative(T - 5_000, T)).toBe('5s ago');
    expect(formatRelative(T - 59_000, T)).toBe('59s ago');
  });
  it('formats minutes', () => {
    expect(formatRelative(T - 60_000, T)).toBe('1m ago');
    expect(formatRelative(T - 30 * 60_000, T)).toBe('30m ago');
  });
  it('formats hours', () => {
    expect(formatRelative(T - 60 * 60_000, T)).toBe('1h ago');
    expect(formatRelative(T - 5 * 60 * 60_000, T)).toBe('5h ago');
  });
  it('formats days', () => {
    expect(formatRelative(T - 24 * 60 * 60_000, T)).toBe('1d ago');
    expect(formatRelative(T - 3 * 24 * 60 * 60_000, T)).toBe('3d ago');
  });
  it('clamps negative deltas to 0s', () => {
    expect(formatRelative(T + 5_000, T)).toBe('0s ago');
  });
});

describe('pathOf', () => {
  it('returns notePath for classifier/suggestion events', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'classifier.ran',
      notePath: '10-Inbox/foo.md',
      model: 'claude-sonnet-4-6',
      outcome: 'route',
      durationMs: 800,
    };
    expect(pathOf(e)).toBe('10-Inbox/foo.md');
  });
  it('returns path for write.committed', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'write.committed',
      toolName: 'create_note',
      path: 'foo.md',
    };
    expect(pathOf(e)).toBe('foo.md');
  });
  it('returns null for index/undo/error events', () => {
    const undo: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'write.undone',
      transactionId: 'tx',
    };
    expect(pathOf(undo)).toBeNull();
  });
});

describe('summarize', () => {
  it('summarizes index.built with notes + chunks + duration', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'index.built',
      notesProcessed: 42,
      chunksAdded: 17,
      chunksSkipped: 0,
      durationMs: 320,
    };
    expect(summarize(e)).toBe('42 notes, 17 chunks (320ms)');
  });

  it('summarizes classifier.ran with outcome + confidence + model', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'classifier.ran',
      notePath: '10-Inbox/foo.md',
      model: 'claude-sonnet-4-6',
      outcome: 'route',
      confidence: 0.93,
      durationMs: 800,
    };
    expect(summarize(e)).toBe('route (93%) — 10-Inbox/foo.md via claude-sonnet-4-6');
  });

  it('summarizes classifier.ran keep outcome without confidence', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'classifier.ran',
      notePath: 'foo.md',
      model: 'claude-haiku-4-5-20251001',
      outcome: 'keep',
      durationMs: 100,
    };
    expect(summarize(e)).toBe('keep — foo.md via claude-haiku-4-5-20251001');
  });

  it('summarizes suggestion.enqueued route with arrow', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'suggestion.enqueued',
      suggestionId: 's1',
      suggestionKind: 'route',
      notePath: '10-Inbox/foo.md',
      target: '22-Decisions',
      confidence: 0.85,
    };
    expect(summarize(e)).toBe('route 10-Inbox/foo.md → 22-Decisions (85%)');
  });

  it('summarizes suggestion.enqueued moc-add with diff arrow', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'suggestion.enqueued',
      suggestionId: 's1',
      suggestionKind: 'moc-add',
      notePath: '10-Inbox/foo.md',
      target: '22-Decisions/00_Index.md',
      confidence: 0.7,
    };
    expect(summarize(e)).toBe(
      'moc-add 10-Inbox/foo.md +→ 22-Decisions/00_Index.md (70%)',
    );
  });

  it('summarizes write.committed with tool + path', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'write.committed',
      toolName: 'create_note',
      path: '90-test/foo.md',
    };
    expect(summarize(e)).toBe('create_note — 90-test/foo.md');
  });

  it('summarizes error with source + message', () => {
    const e: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'error',
      source: 'classifier',
      message: 'rate limit',
    };
    expect(summarize(e)).toBe('classifier — rate limit');
  });

  it('summarizes suggestion.skipped with bulk flag', () => {
    const single: ActivityEvent = {
      id: '1',
      timestamp: T,
      kind: 'suggestion.skipped',
      suggestionId: 's1',
      notePath: 'a.md',
      bulk: false,
    };
    expect(summarize(single)).toBe('single — a.md');
    const bulk: ActivityEvent = {
      id: '2',
      timestamp: T,
      kind: 'suggestion.skipped',
      suggestionId: 's2',
      notePath: 'b.md',
      bulk: true,
    };
    expect(summarize(bulk)).toBe('bulk — b.md');
  });
});
