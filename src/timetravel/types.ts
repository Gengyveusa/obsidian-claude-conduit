/**
 * Phase 16 (v1.10.0) — time-travel snapshot metadata per ADR-037.
 *
 * The chunks themselves live in the SQLite index under `commit_sha = <sha>`.
 * This metadata table (persisted in plugin settings) is the parallel
 * record of WHICH SHAs exist as snapshots, WHEN they were taken, and
 * what the operator labelled them. Keeps the picker UX fast (no
 * GROUP BY scan on every render) and gives GC the timestamps it needs
 * to expire untagged snapshots per ADR-037 D4.
 */

export interface SnapshotMeta {
  /** Full git commit SHA (40 hex chars; abbreviated only for display). */
  commitSha: string;
  /**
   * ISO-8601 date the snapshot was taken (YYYY-MM-DD, plugin local
   * timezone). Operators see this in the picker. Cited responses
   * suffix `[[note]] (as of YYYY-MM-DD)` with this date per ADR-037 D8.
   */
  date: string;
  /** Epoch ms when the snapshot was indexed. Drives GC age math. */
  createdAt: number;
  /**
   * Operator-visible label: the git tag pointing at this SHA if any,
   * else null. Used by the picker to surface "v1.5.0" / "q1-decisions"
   * etc. and by GC to keep tagged snapshots indefinitely per ADR-037 D4.
   */
  tag: string | null;
  /**
   * Operator-pinned: when true, the snapshot is exempt from age-based
   * GC regardless of `createdAt`. Default false; promoted via the
   * v2.0.5 `Sagittarius: Pin snapshot` command per ADR-037 D4
   * (follow-up slot — session 3 surface).
   */
  pinned: boolean;
  /** Notes-processed count from the index pass (for the picker subtitle). */
  chunkCount: number;
}
