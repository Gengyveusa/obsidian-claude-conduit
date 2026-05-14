import type { VaultAdapter } from '../agent/types';

/**
 * Phase 9 (v1.3.0) — CLAUDE.md cascade per ADR-029.
 *
 * Discovers every `CLAUDE.md` file the agent should see for the
 * current active file: vault-root first, then each ancestor folder
 * of the active path (D2). Files are loaded in root-most-first order
 * so the model reads general guidance before folder-specific
 * overrides (D3).
 *
 * Pure logic with one I/O dependency (`VaultAdapter`); no plugin
 * coupling so tests run against an in-memory adapter.
 *
 * Size budget (D4): caller passes `maxBytes`; the cascade
 * soft-truncates the file that pushes the running total over the
 * cap and skips any files after it.
 */

/** Sentinel filename per D1 — verbatim, case-sensitive, not configurable. */
export const MEMORY_FILENAME = 'CLAUDE.md';

/** One CLAUDE.md file's worth of memory. */
export interface MemorySection {
  /** Vault-relative path, e.g. `CLAUDE.md` or `30-Projects/CLAUDE.md`. */
  path: string;
  /**
   * The bytes loaded. May be truncated if this section was the one
   * that crossed the budget — `truncated: true` in that case so the
   * status-bar pill / footer can show it.
   */
  text: string;
  /** Did the budget cap force a partial read of this file? */
  truncated: boolean;
  /** Original file size on disk, in bytes (pre-truncation). */
  sizeBytes: number;
}

/** Result of one cascade build. */
export interface CascadeResult {
  sections: MemorySection[];
  /** Sum of `text.length` across all sections — what's actually injected. */
  totalBytes: number;
  /** True if any file was truncated OR skipped because of the cap. */
  budgetHit: boolean;
}

export interface CollectMemoryOpts {
  /** The adapter to read CLAUDE.md files through. */
  adapter: VaultAdapter;
  /**
   * Vault-relative path of the active file, e.g.
   * `30-Projects/sagittarius/notes/2026-05-14.md`. `null` when no
   * file is active (Cmd+P quick question, no leaf open, etc.) —
   * the cascade falls back to root-only per D2.
   */
  activeFilePath: string | null;
  /** Total injection budget in bytes. Caller defaults to 50_000 per D4. */
  maxBytes: number;
}

/**
 * Build the cascade for one chat turn. Reads CLAUDE.md files from
 * the vault root down through every ancestor folder of the active
 * file. Missing files at any level are silently skipped.
 *
 * @example
 *   const result = await collectMemory({
 *     adapter,
 *     activeFilePath: '30-Projects/sagittarius/notes/today.md',
 *     maxBytes: 50_000,
 *   });
 *   // result.sections is up to 4 entries (root, 30-Projects,
 *   // 30-Projects/sagittarius, 30-Projects/sagittarius/notes)
 */
export async function collectMemory(
  opts: CollectMemoryOpts,
): Promise<CascadeResult> {
  const candidatePaths = candidateCascadePaths(opts.activeFilePath);
  const sections: MemorySection[] = [];
  let runningTotal = 0;
  let budgetHit = false;

  for (const path of candidatePaths) {
    if (!(await opts.adapter.exists(path))) {
      continue;
    }
    const raw = await opts.adapter.read(path);
    if (raw.length === 0) {
      continue;
    }
    const remaining = opts.maxBytes - runningTotal;
    if (remaining <= 0) {
      // Budget already blown; skip everything else per D4.
      budgetHit = true;
      break;
    }
    if (raw.length <= remaining) {
      sections.push({ path, text: raw, truncated: false, sizeBytes: raw.length });
      runningTotal += raw.length;
      continue;
    }
    // Soft truncation per D4: take what fits, append the marker,
    // stop processing further files.
    const truncated = raw.slice(0, remaining) + TRUNCATION_MARKER;
    sections.push({
      path,
      text: truncated,
      truncated: true,
      sizeBytes: raw.length,
    });
    runningTotal += truncated.length;
    budgetHit = true;
    break;
  }

  return { sections, totalBytes: runningTotal, budgetHit };
}

/** Marker appended when budget forces a partial read per D4. */
export const TRUNCATION_MARKER = '\n\n... [truncated for memory budget] ...\n';

/**
 * Compute the ordered list of CLAUDE.md paths the cascade would try
 * to load, regardless of which exist. Root-first, then each ancestor
 * folder of `activeFilePath` (if provided), then the active file's
 * own folder.
 *
 * Pure — no I/O. The cascade's existence check happens in
 * `collectMemory`; this function is the deterministic *order*.
 *
 * @example
 *   candidateCascadePaths('30-Projects/sagittarius/notes/today.md')
 *   // → ['CLAUDE.md', '30-Projects/CLAUDE.md',
 *   //    '30-Projects/sagittarius/CLAUDE.md',
 *   //    '30-Projects/sagittarius/notes/CLAUDE.md']
 */
export function candidateCascadePaths(activeFilePath: string | null): string[] {
  const paths: string[] = [MEMORY_FILENAME];
  if (activeFilePath === null) {
    return paths;
  }
  const normalized = activeFilePath.replace(/^\/+/, '');
  const segments = normalized.split('/');
  // Drop the filename segment — we want folders only.
  segments.pop();
  let acc = '';
  for (const seg of segments) {
    if (seg.length === 0) {
      continue;
    }
    acc = acc.length === 0 ? seg : `${acc}/${seg}`;
    paths.push(`${acc}/${MEMORY_FILENAME}`);
  }
  return paths;
}

/**
 * Render the cascade as the labeled-sections text block injected
 * into the system prompt per D3 + D5. Returns `null` when there's
 * nothing to inject — the caller skips adding a memory block in
 * that case.
 *
 * @example
 *   formatMemoryPromptText([
 *     { path: 'CLAUDE.md', text: 'use snake_case', truncated: false, sizeBytes: 14 },
 *   ])
 *   // → '# Memory: CLAUDE.md\n\nuse snake_case'
 */
export function formatMemoryPromptText(sections: ReadonlyArray<MemorySection>): string | null {
  if (sections.length === 0) {
    return null;
  }
  const blocks: string[] = [];
  for (const section of sections) {
    blocks.push(`# Memory: ${section.path}\n\n${section.text.trimEnd()}`);
  }
  return blocks.join('\n\n');
}

/**
 * Compact one-line summary suitable for the chat-response footer
 * per D7: `memory: 2.1KB from /, 30-Projects/` (or `memory: none`).
 *
 * @example
 *   formatMemoryFooter({ sections: [...], totalBytes: 2148, budgetHit: false })
 *   // → 'memory: 2.1KB from CLAUDE.md, 30-Projects/CLAUDE.md'
 */
export function formatMemoryFooter(result: CascadeResult): string {
  if (result.sections.length === 0) {
    return 'memory: none';
  }
  const bytes = formatBytes(result.totalBytes);
  const paths = result.sections.map((s) => s.path).join(', ');
  const marker = result.budgetHit ? ' (budget hit — truncated)' : '';
  return `memory: ${bytes} from ${paths}${marker}`;
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n}B`;
  }
  return `${(n / 1024).toFixed(1)}KB`;
}
