import type { CuratorRule } from '../CuratorRule';
import type { CuratorFinding } from '../types';

/**
 * Phase 7 (v1.0.0) — orphan-archive detector per ADR-022 D1.
 *
 * "Orphan" here means: a note that has zero inbound links from any other
 * note in the corpus. By itself that's not actionable — orphans include
 * many legitimate notes (the literal root of a knowledge tree, fresh
 * inbox notes, etc.). The rule pairs orphan-detection with a staleness
 * threshold: orphan AND last-modified more than N days ago → archive
 * candidate.
 *
 * This is conservative on purpose. Phase 5's organization engine
 * already handles fresh notes in `10-Inbox/`; this rule is for notes
 * that landed in their "permanent" folder but never connected to
 * anything else.
 *
 * Pure detector — no LLM. Severity scales with staleness: 0.4 at the
 * threshold, climbing toward 0.8 at 4× the threshold. Caps at 0.8 so
 * broken-link findings (0.9) still outrank stale-orphan findings of
 * comparable severity.
 *
 * @example finding shape
 *   {
 *     ruleName: 'orphan',
 *     notePath: '50-Archive/2023/old-note.md',
 *     severity: 0.6,
 *     reason: 'No inbound links and last modified 187 days ago',
 *     payload: { archiveFolder: '_archive/2024', staleDays: 187 },
 *   }
 */
export const ORPHAN_RULE_NAME = 'orphan';

const DEFAULT_STALE_THRESHOLD_DAYS = 90;

export interface OrphanRuleOptions {
  /**
   * Days since last modification before a note is eligible. Notes
   * modified more recently are skipped even if they're orphans.
   * Default 90 per ADR-022.
   */
  staleThresholdDays?: number;
  /**
   * Folders to ignore — orphans in these are expected. Default
   * includes `_archive/` (already archived) and `_logs/`. Vault-relative,
   * no leading slash, no trailing slash.
   */
  ignoredFolders?: string[];
  /** Test-injectable clock. */
  now?: () => number;
}

export function makeOrphanRule(opts: OrphanRuleOptions = {}): CuratorRule {
  const staleThresholdDays = opts.staleThresholdDays ?? DEFAULT_STALE_THRESHOLD_DAYS;
  const ignoredFolders = opts.ignoredFolders ?? ['_archive', '_logs'];
  const now = opts.now ?? (() => Date.now());

  return {
    name: ORPHAN_RULE_NAME,
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
        const inbound = await corpus.backlinks(notePath);
        if (inbound.length > 0) {
          continue;
        }
        const staleDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        findings.push({
          ruleName: ORPHAN_RULE_NAME,
          notePath,
          severity: severityFromAge(staleDays, staleThresholdDays),
          reason: `No inbound links and last modified ${staleDays} day(s) ago`,
          payload: {
            archiveFolder: archiveFolderFor(stat.mtime),
            staleDays,
          },
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
 * Map staleness in days to a 0.4-0.8 severity score. At the threshold,
 * severity is 0.4. Severity climbs linearly to 0.8 at 4× the threshold,
 * then caps. Exported for tests.
 */
export function severityFromAge(staleDays: number, thresholdDays: number): number {
  if (staleDays <= thresholdDays) {
    return 0.4;
  }
  const excess = staleDays - thresholdDays;
  const range = thresholdDays * 3; // From threshold → 4× threshold.
  const ratio = Math.min(excess / range, 1);
  return 0.4 + ratio * 0.4;
}

/**
 * Compute the destination archive folder from a note's mtime. Year
 * bucket, vault-relative `_archive/YYYY`. Exported for tests.
 */
export function archiveFolderFor(mtimeMs: number): string {
  const year = new Date(mtimeMs).getUTCFullYear();
  return `_archive/${year}`;
}
