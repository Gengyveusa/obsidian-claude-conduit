import type { SnapshotMeta } from './types';

/**
 * Phase 16 (v2.0.0) — pure GC pass per ADR-037 D4.
 *
 * Snapshots fall into three retention buckets:
 *
 *   1. **Tagged** (`tag !== null`) — kept indefinitely. The operator
 *      deliberately marked the commit; we don't expire it.
 *   2. **Pinned** (`pinned === true`) — kept indefinitely. Operator
 *      promoted the snapshot via the v2.0.5 follow-up Pin command.
 *   3. **Untagged + unpinned** — expire after `retentionDays` since
 *      `createdAt`. This is the only bucket the GC touches.
 *
 * Current-state rows (`commit_sha IS NULL`) live entirely outside this
 * model — they're not in `snapshots` and are never expired.
 *
 * Pure: takes inputs, returns a partition. The caller is responsible
 * for the side effects (`engine.deleteChunksForCommit` + persisting
 * the surviving list to settings).
 *
 * @example
 *   const { keep, expire } = partitionExpiredSnapshots(snapshots, Date.now(), 365);
 *   for (const s of expire) engine.deleteChunksForCommit(s.commitSha);
 *   await plugin.saveSettings({ timeTravelSnapshots: keep });
 */
export function partitionExpiredSnapshots(
  snapshots: ReadonlyArray<SnapshotMeta>,
  nowMs: number,
  retentionDays: number,
): { keep: SnapshotMeta[]; expire: SnapshotMeta[] } {
  if (retentionDays <= 0) {
    // 0 (or negative) means no expiration. Defensive — UI should not
    // produce negatives but we don't want to suddenly nuke everything
    // if a setting load returns 0.
    return { keep: [...snapshots], expire: [] };
  }
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const keep: SnapshotMeta[] = [];
  const expire: SnapshotMeta[] = [];
  for (const snap of snapshots) {
    if (snap.tag !== null || snap.pinned) {
      keep.push(snap);
      continue;
    }
    if (snap.createdAt >= cutoff) {
      keep.push(snap);
      continue;
    }
    expire.push(snap);
  }
  return { keep, expire };
}

/**
 * Phase 16 (v2.0.0) — should the GC pass run on this plugin load?
 *
 * GC is cheap when there's nothing to do (a single `Date.now()` +
 * comparison) but the chunks-table DELETE on actual expirations isn't
 * free, and we don't want plugin loads to compete with the operator's
 * first action. Per ADR-037 D4 the schedule is "once per plugin load
 * if >24h since last GC".
 *
 * Pure: takes inputs, returns a boolean. Caller persists `lastGcAt`
 * after running.
 *
 * @example
 *   if (shouldRunGc(Date.now(), settings.timeTravelLastGcAt, settings.timeTravelEnabled)) {
 *     await runGc(...);
 *   }
 */
export function shouldRunGc(
  nowMs: number,
  lastGcAtMs: number,
  timeTravelEnabled: boolean,
): boolean {
  if (!timeTravelEnabled) {
    return false;
  }
  if (lastGcAtMs <= 0) {
    // Never run before — run on first opt-in load.
    return true;
  }
  const elapsedHours = (nowMs - lastGcAtMs) / (60 * 60 * 1000);
  return elapsedHours >= 24;
}
