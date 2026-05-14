/**
 * Phase 7 (v1.0.0) curator types per
 * [ADR-022](../../docs/2026-05-13-adr-022-phase-7-curator-plan.md).
 *
 * The curator is a phase-7 layer on top of Phase 5's suggestion queue.
 * Rules find "vault hygiene" issues; the orchestrator collects, ranks,
 * caps, and (in PR 2) enqueues them as suggestions. Apply paths reuse
 * the Phase 4 write tools + diff card per ADR-016 D2.
 */

/**
 * A single hygiene issue found by a `CuratorRule`. Opaque-payload —
 * each rule attaches whatever data its apply-path needs (target link,
 * archive destination, frontmatter fields). The orchestrator only
 * cares about the common fields below.
 */
export interface CuratorFinding {
  /** Stable id of the rule that produced this finding. */
  ruleName: string;
  /** Note the finding is about. Used for dedup + UX. */
  notePath: string;
  /**
   * 0..1 severity. Higher = surface sooner. Per ADR-022 D6 the
   * orchestrator ranks by this when applying the per-sweep cap.
   * Rules compute this deterministically from the finding shape
   * (no LLM judgment), so re-running is stable.
   */
  severity: number;
  /** Short human-readable explanation. Surfaced in the SuggestionsView row. */
  reason: string;
  /**
   * Rule-specific payload. The apply-path (in PR 2+) reads this to
   * decide what tool to invoke with what arguments. Orchestrator
   * passes it through unchanged.
   */
  payload?: Record<string, unknown>;
}

/**
 * Outcome of a single orchestrator sweep. Used by the caller to log,
 * emit activity events, and decide what to do next.
 */
export interface CuratorRunOutcome {
  /** How many rules ran (errored rules counted). */
  rulesRun: number;
  /** Total findings produced across all rules, pre-cap. */
  totalDetected: number;
  /** Findings that survived ranking + cap, severity-sorted desc. */
  enqueued: CuratorFinding[];
  /** Findings dropped because they fell beyond `maxPerSweep`. */
  capped: number;
  /** Per-rule errors during `detect()`. The sweep continues across them. */
  errors: Array<{ ruleName: string; message: string }>;
  /** Total wall-clock time of the sweep in milliseconds. */
  durationMs: number;
}

/**
 * Read-only view of the vault the rules consume. Decoupled from
 * `VaultAdapter` because rules don't need to write. Lets us mock the
 * corpus surface entirely in unit tests.
 */
export interface CuratorCorpus {
  /** Return every `.md` path in the vault. Used by orphan / stale rules. */
  listAllMarkdown(): Promise<string[]>;
  /** Read a note's content. */
  read(path: string): Promise<string>;
  /** Stat a note — mtime + size. Null when missing. */
  stat(path: string): Promise<CorpusStat | null>;
  /** Return the outbound wikilinks of `path` (link targets, not display text). */
  outboundLinks(path: string): Promise<string[]>;
  /** Return the inbound backlink sources for `path`. */
  backlinks(path: string): Promise<string[]>;
}

export interface CorpusStat {
  /** Unix milliseconds. */
  mtime: number;
  /** Unix milliseconds. */
  ctime: number;
  /** Bytes. */
  size: number;
}
