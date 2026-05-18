import { describe, expect, it } from 'vitest';

import { partitionExpiredSnapshots, shouldRunGc } from '../../src/timetravel/gc';
import type { SnapshotMeta } from '../../src/timetravel/types';

function snap(overrides: Partial<SnapshotMeta>): SnapshotMeta {
  return {
    commitSha: 'a'.repeat(40),
    date: '2026-01-01',
    createdAt: Date.UTC(2026, 0, 1),
    tag: null,
    pinned: false,
    chunkCount: 100,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe('partitionExpiredSnapshots (ADR-037 D4)', () => {
  it('keeps tagged snapshots regardless of age', () => {
    const now = Date.UTC(2027, 0, 1);
    const snapshots = [
      snap({ tag: 'v1.5.0', createdAt: Date.UTC(2024, 0, 1) }),
    ];
    const { keep, expire } = partitionExpiredSnapshots(snapshots, now, 365);
    expect(keep).toHaveLength(1);
    expect(expire).toHaveLength(0);
  });

  it('keeps pinned snapshots regardless of age', () => {
    const now = Date.UTC(2027, 0, 1);
    const snapshots = [snap({ pinned: true, createdAt: Date.UTC(2024, 0, 1) })];
    const { keep, expire } = partitionExpiredSnapshots(snapshots, now, 365);
    expect(keep).toHaveLength(1);
    expect(expire).toHaveLength(0);
  });

  it('expires untagged + unpinned snapshots past the retention window', () => {
    const now = Date.UTC(2026, 6, 1);
    const oldSnap = snap({
      commitSha: 'b'.repeat(40),
      createdAt: now - 400 * DAY,
    });
    const freshSnap = snap({
      commitSha: 'c'.repeat(40),
      createdAt: now - 30 * DAY,
    });
    const { keep, expire } = partitionExpiredSnapshots([oldSnap, freshSnap], now, 365);
    expect(keep.map((s) => s.commitSha)).toEqual(['c'.repeat(40)]);
    expect(expire.map((s) => s.commitSha)).toEqual(['b'.repeat(40)]);
  });

  it('treats snapshots exactly at the cutoff as kept (inclusive boundary)', () => {
    const now = Date.UTC(2026, 6, 1);
    const atCutoff = snap({ createdAt: now - 365 * DAY });
    const { keep, expire } = partitionExpiredSnapshots([atCutoff], now, 365);
    expect(keep).toHaveLength(1);
    expect(expire).toHaveLength(0);
  });

  it('treats one-ms past the cutoff as expired', () => {
    const now = Date.UTC(2026, 6, 1);
    const justPast = snap({ createdAt: now - 365 * DAY - 1 });
    const { keep, expire } = partitionExpiredSnapshots([justPast], now, 365);
    expect(keep).toHaveLength(0);
    expect(expire).toHaveLength(1);
  });

  it('keeps everything when retentionDays <= 0 (defensive)', () => {
    const snapshots = [
      snap({ commitSha: 'a'.repeat(40), createdAt: 0 }),
      snap({ commitSha: 'b'.repeat(40), createdAt: 0 }),
    ];
    expect(partitionExpiredSnapshots(snapshots, Date.now(), 0).expire).toHaveLength(0);
    expect(partitionExpiredSnapshots(snapshots, Date.now(), -1).expire).toHaveLength(0);
  });

  it('returns empty arrays for empty input', () => {
    const { keep, expire } = partitionExpiredSnapshots([], Date.now(), 365);
    expect(keep).toEqual([]);
    expect(expire).toEqual([]);
  });
});

describe('shouldRunGc (ADR-037 D4)', () => {
  it('skips when time-travel is disabled', () => {
    expect(shouldRunGc(Date.now(), 0, false)).toBe(false);
    expect(shouldRunGc(Date.now(), Date.now() - 100 * DAY, false)).toBe(false);
  });

  it('runs on first opt-in (lastGcAt = 0)', () => {
    expect(shouldRunGc(Date.now(), 0, true)).toBe(true);
  });

  it('skips when <24h since last GC', () => {
    const now = Date.now();
    expect(shouldRunGc(now, now - 6 * 60 * 60 * 1000, true)).toBe(false);
    expect(shouldRunGc(now, now - 23 * 60 * 60 * 1000, true)).toBe(false);
  });

  it('runs when >=24h since last GC', () => {
    const now = Date.now();
    expect(shouldRunGc(now, now - 24 * 60 * 60 * 1000, true)).toBe(true);
    expect(shouldRunGc(now, now - 30 * DAY, true)).toBe(true);
  });
});
