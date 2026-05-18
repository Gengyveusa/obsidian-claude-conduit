/**
 * Phase 14 (v1.7.0) — daily briefing path conventions per ADR-035 D1.
 *
 * Briefings live at `_briefings/<YYYY-MM-DD>.md`. Same underscore-prefix
 * quarantine pattern as `_drafts/`, `_memory/`, `_chats/`. One file per
 * local day per the operator's configured timezone.
 *
 * Pure — no I/O. Mirrors `journalPathFor` from Phase 12.
 */

/** Folder prefix all briefings live under per ADR-035 D1. */
export const BRIEFINGS_ROOT = '_briefings/';

/**
 * Compute the briefing file path for a given date in the operator's
 * timezone. Mirrors `journalPathFor` so both subsystems agree on what
 * "today" means.
 *
 * @example
 *   briefingPathFor(new Date(), 'America/Los_Angeles')
 *   // → '_briefings/2026-05-16.md'
 */
export function briefingPathFor(now: Date, timezone: string): string {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: timezone });
  return `${BRIEFINGS_ROOT}${ymd}.md`;
}

/** True iff `path` is a briefing path Sagittarius might have written. */
export function isBriefingPath(path: string): boolean {
  if (!path.startsWith(BRIEFINGS_ROOT)) {
    return false;
  }
  const rest = path.slice(BRIEFINGS_ROOT.length);
  if (rest.startsWith('_archive/')) {
    return false;
  }
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(rest);
}

/** Extract the YYYY-MM-DD date string from a briefing path. */
export function briefingDateFor(path: string): string | null {
  if (!isBriefingPath(path)) {
    return null;
  }
  const rest = path.slice(BRIEFINGS_ROOT.length);
  return rest.replace(/\.md$/, '');
}
