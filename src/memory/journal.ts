import type { VaultAdapter } from '../agent/types';

/**
 * Phase 12 (v1.5.0) — reverse-memory journal helpers per ADR-033.
 *
 * Pure(-ish) module: path computation is sync; the journal-listing
 * helper takes a `VaultAdapter` and reads files. No plugin coupling
 * so tests run against an in-memory adapter.
 *
 * Architecture per ADR-033:
 *   - One file per local day at `_memory/<YYYY-MM-DD>.md` (D1)
 *   - Multiple sessions in the same day append H2 sections (D1)
 *   - Cascade reads the most-recent N daily files (D5)
 *   - All writes go through `append_to_note` / `create_note` per
 *     ADR-016 D2 — this module never touches the filesystem to write
 */

/** Folder prefix all journal files live under (D1; mirrors `_drafts/` convention). */
export const JOURNAL_ROOT = '_memory/';

/** Single section in a journal entry per ADR-033 D3 (the four bullets). */
export interface JournalSection {
  /** What the operator was working on this session. */
  workedOn: string;
  /** Decisions noted during the session. */
  decided: string;
  /** Facts about the operator the agent learned. */
  learnedAboutOperator: string;
  /** Open threads / TODOs the next session should know about. */
  openThreads: string;
}

/**
 * Compute the journal-file path for a given date.
 * Date interpretation matches the operator's local timezone — caller
 * passes `new Date()`; `toLocaleDateString('en-CA')` gives YYYY-MM-DD.
 *
 * @example
 *   journalPathFor(new Date(), 'America/Los_Angeles')
 *   // → '_memory/2026-05-15.md'
 */
export function journalPathFor(now: Date, timezone: string): string {
  // 'en-CA' produces YYYY-MM-DD format; the timezone option is widely
  // supported and interprets `now` in that zone before formatting.
  const ymd = now.toLocaleDateString('en-CA', { timeZone: timezone });
  return `${JOURNAL_ROOT}${ymd}.md`;
}

/** True iff `path` is a journal file Sagittarius might have written. */
export function isJournalPath(path: string): boolean {
  if (!path.startsWith(JOURNAL_ROOT)) {
    return false;
  }
  // Skip `_archive/` subfolder per ADR-033 D6 — operators move old
  // journals there to keep them from cascade injection.
  const rest = path.slice(JOURNAL_ROOT.length);
  if (rest.startsWith('_archive/')) {
    return false;
  }
  // Match YYYY-MM-DD.md exactly — guards against accidental extra files.
  return /^\d{4}-\d{2}-\d{2}\.md$/.test(rest);
}

/**
 * Render a `JournalSection` as a markdown H2 block per ADR-033 D3.
 * Caller prepends with the timestamp/title.
 *
 * @example
 *   formatJournalSection(date, 'Phase 12 planning', section)
 *   // → '## 2026-05-15 22:14 — Phase 12 planning\n\n- **Worked on:** ...'
 */
export function formatJournalSection(
  timestamp: Date,
  title: string,
  section: JournalSection,
  timezone: string,
): string {
  const stamp = timestamp.toLocaleString('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const header = `## ${stamp.replace(', ', ' ')} — ${title.trim()}`;
  return [
    header,
    '',
    `- **Worked on:** ${oneLine(section.workedOn)}`,
    `- **Decided:** ${oneLine(section.decided)}`,
    `- **Learned about operator:** ${oneLine(section.learnedAboutOperator)}`,
    `- **Open threads:** ${oneLine(section.openThreads)}`,
  ].join('\n');
}

/** Collapse newlines + trim so each bullet stays on one line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * List the N most-recent journal files (newest first). Used by the
 * cascade per ADR-033 D5. `limit` is the configurable
 * `journalCascadeDays` setting; default 3.
 *
 * Files are sorted by their YYYY-MM-DD filename (string sort works
 * because the format is fixed-width). `_archive/` is excluded.
 */
export async function listRecentJournals(
  adapter: VaultAdapter,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }
  const all = await adapter.listAllMarkdown();
  const journals = all.filter((p) => isJournalPath(p));
  // Newest-first by filename (YYYY-MM-DD sorts lexicographically).
  journals.sort((a, b) => b.localeCompare(a));
  return journals.slice(0, limit);
}

/**
 * Render the recent journals as a labeled section for the system
 * prompt cascade. Returns `null` when no journals exist or `limit` is
 * 0 — caller skips adding the section in that case.
 *
 * The output sits ABOVE the CLAUDE.md cascade per ADR-033 D5 so the
 * agent reads its own most-recent memory first.
 *
 * @example
 *   const text = await formatJournalCascade(adapter, 3);
 *   // → '# Memory: recent session journals (most recent first)\n\n## 2026-05-15\n...'
 */
export async function formatJournalCascade(
  adapter: VaultAdapter,
  limit: number,
): Promise<string | null> {
  const paths = await listRecentJournals(adapter, limit);
  if (paths.length === 0) {
    return null;
  }
  const sections: string[] = ['# Memory: recent session journals (most recent first)', ''];
  for (const path of paths) {
    let content: string;
    try {
      content = await adapter.read(path);
    } catch {
      continue; // file vanished between list + read; skip
    }
    if (content.trim().length === 0) {
      continue;
    }
    // Filename → date label so the agent knows when each entry was
    // written (vs. relying on the H2 timestamps inside).
    const ymd = path.slice(JOURNAL_ROOT.length).replace(/\.md$/, '');
    sections.push(`## ${ymd}`);
    sections.push('');
    sections.push(content.trim());
    sections.push('');
  }
  // If every file was empty/missing, suppress the section entirely.
  if (sections.length === 2) {
    return null;
  }
  return sections.join('\n').trimEnd();
}
