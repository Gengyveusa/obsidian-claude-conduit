import type { VaultAdapter } from '../agent/types';

import { listRecentJournals } from '../memory/journal';

/**
 * Phase 14 (v1.7.0) — extract "Open threads" bullets from recent
 * journal files per ADR-035 D3 (the sixth briefing section).
 *
 * Phase 12 journals are markdown H2 blocks with a four-bullet body:
 *
 *   - **Worked on:** ...
 *   - **Decided:** ...
 *   - **Learned about operator:** ...
 *   - **Open threads:** <one-line summary>
 *
 * This helper scans the most-recent N journal files, pulls the
 * "Open threads" bullet from each H2 block, and returns the
 * threads strings in newest-first order. Empty / "none" threads
 * are filtered out so the briefing doesn't render placeholder
 * cruft.
 */

/** Match an "Open threads" bullet line; same regex shape Phase 12 uses. */
const OPEN_THREADS_PATTERN =
  /^\s*[-*]\s*[*_]{0,2}Open threads[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.+?)\s*$/im;

/**
 * Read the most-recent `limit` journal files and pull their
 * "Open threads" bullets. Returns one string per H2 section found
 * (a journal file with N session entries can contribute N threads).
 *
 * Filters out: empty values, literal "none" (case-insensitive),
 * and the Phase 12 "(not specified)" placeholder.
 *
 * @example
 *   const threads = await extractOpenThreads(adapter, 3);
 *   // → ['v1.4.2 tag/release pending', 'Phase 13 conversational notes']
 */
export async function extractOpenThreads(
  adapter: VaultAdapter,
  limit: number,
): Promise<string[]> {
  if (limit <= 0) {
    return [];
  }
  const paths = await listRecentJournals(adapter, limit);
  const threads: string[] = [];
  for (const path of paths) {
    let content: string;
    try {
      content = await adapter.read(path);
    } catch {
      continue;
    }
    threads.push(...extractFromMarkdown(content));
  }
  return threads;
}

/**
 * Pull every "Open threads:" bullet from one journal file's content.
 * Each H2 section can contribute one thread; multiple sessions in
 * the same day produce multiple H2 blocks.
 *
 * Exported for tests so we can verify parsing without I/O.
 */
export function extractFromMarkdown(content: string): string[] {
  const out: string[] = [];
  // Split on H2 boundaries so each section's "Open threads" bullet
  // is local to its section (avoid pulling the same regex match
  // across multiple sections by accident).
  const sections = content.split(/^##\s/m);
  for (const section of sections) {
    const match = OPEN_THREADS_PATTERN.exec(section);
    if (match === null) {
      continue;
    }
    const value = match[1].trim().replace(/[*_]{2,}$/, '').trim();
    if (!isMeaningful(value)) {
      continue;
    }
    out.push(value);
  }
  return out;
}

function isMeaningful(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const lower = value.toLowerCase();
  if (lower === 'none' || lower === 'none.' || lower === 'n/a') {
    return false;
  }
  if (value === '(not specified)') {
    return false;
  }
  return true;
}
