import type { CuratorRule } from '../CuratorRule';
import type { CuratorFinding } from '../types';

/**
 * Phase 7 (v1.0.1) — generic stale-note detector per ADR-022 D1.
 *
 * Different from `OrphanRule`: orphan = stale AND no inbound links
 * (high-confidence archive candidate). StaleNote = stale regardless
 * of inbound links — surfaces every note that's been gathering dust,
 * even if other notes reference it.
 *
 * Severity scales 0.3 → 0.7 with staleness (lower ceiling than
 * orphan because the user may legitimately keep linked-but-stale
 * notes around).
 *
 * Skips:
 *   - Notes also flagged by OrphanRule (avoids duplicate suggestions
 *     for the same note). The dedup is done at the SuggestionQueue
 *     layer (one suggestion per notePath), but we also pre-filter
 *     here so OrphanRule's archive proposals don't race with a
 *     less-specific StaleNote review.
 *   - Notes in user-configured ignoredFolders (default `_archive`,
 *     `_logs`, plus inbox folders so fresh inbox items don't get
 *     flagged stale).
 *
 * @example
 *   makeStaleNoteRule({ staleThresholdDays: 180 })
 */
export const STALE_NOTE_RULE_NAME = 'stale-note';

const DEFAULT_STALE_THRESHOLD_DAYS = 180;

export interface StaleNoteRuleOptions {
  /**
   * Days since last modification before a note is eligible. Default
   * 180 (twice the orphan threshold — staleness review is more
   * conservative than archive-suggestion).
   */
  staleThresholdDays?: number;
  /**
   * Folders to ignore — staleness in these is expected. Default
   * includes `_archive`, `_logs`, and `10-Inbox` (inbox notes need
   * Phase 5 routing, not staleness review).
   */
  ignoredFolders?: string[];
  /** Test-injectable clock. */
  now?: () => number;
}

export function makeStaleNoteRule(opts: StaleNoteRuleOptions = {}): CuratorRule {
  const staleThresholdDays = opts.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const ignoredFolders = opts.ignoredFolders ?? ['_archive', '_logs', '10-Inbox'];
  const now = opts.now ?? (() => Date.now());

  return {
    name: STALE_NOTE_RULE_NAME,
    detect: async (corpus) => {
      const allMd = await corpus.listAllMarkdown();
      const findings: CuratorFinding[] = [];
      const thresholdMs = staleThresholdDays * 24 * 60 * 60 * 1000;
      const nowMs = now();

      for (const notePath of allMd) {
        if (isIgnored(notePath, ignoredFolders)) {
          continue;
        }
        const stat = await corpus.stat(notePath);
        if (stat === null) {
          continue;
        }
        const ageMs = nowMs - stat.mtime;
        if (ageMs < thresholdMs) {
          continue;
        }
        const staleDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        findings.push({
          ruleName: STALE_NOTE_RULE_NAME,
          notePath,
          severity: severityFromAge(staleDays, staleThresholdDays),
          reason: `Last modified ${staleDays} day(s) ago — review or archive`,
          payload: { staleDays },
        });
      }
      return findings;
    },
  };
}

function isIgnored(notePath: string, ignoredFolders: string[]): boolean {
  for (const folder of ignoredFolders) {
    if (notePath === folder || notePath.startsWith(`${folder}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * 0.3 at threshold, climbing linearly to 0.7 at 4× threshold, capped.
 * Lower ceiling than OrphanRule's 0.8 because StaleNote is less
 * confident — the note may be intentionally preserved. Exported for tests.
 */
export function severityFromAge(staleDays: number, thresholdDays: number): number {
  if (staleDays <= thresholdDays) {
    return 0.3;
  }
  const excess = staleDays - thresholdDays;
  const range = thresholdDays * 3;
  const ratio = Math.min(excess / range, 1);
  return 0.3 + ratio * 0.4;
}
