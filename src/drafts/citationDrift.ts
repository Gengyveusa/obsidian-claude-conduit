import type { VaultAdapter } from '../agent/types';
import type { SqliteEngine } from '../retrieval/SqliteEngine';
import { splitFrontmatter } from '../util/frontmatter';

import { isDraftPath } from './paths';
import type { CitedChunk } from './types';

/**
 * Phase 9 (v1.3.4) — citation-drift verification per the v1.2.x OQ1
 * follow-up noted in ADR-026 + ADR-028.
 *
 * Pre-promotion check: every entry in a draft's `cited_chunks: [...]`
 * frontmatter is verified against the current retrieval index. The
 * caller (`runPromoteDraft`) decides what to do with the report —
 * silently proceed when there's no drift, or surface a confirmation
 * Notice / modal when there is.
 *
 * Two flavors of drift, classified separately because they imply
 * different operator actions:
 *
 *   - `missingChunks`: the source note still exists but the cited
 *     chunk index is out of range. Usually means the note was
 *     re-chunked (edited heavily). The text the draft cited may
 *     no longer be at that location — operator should re-read.
 *
 *   - `missingNotes`: the source note doesn't exist at all
 *     anymore. Moved, renamed, or deleted. The citation is
 *     dangling — operator should investigate before promoting.
 *
 * Pure(-ish): one I/O hit (read the draft) + lookups against the
 * already-loaded engines. No network, no embedding recompute.
 *
 * Non-draft input: throws. Drift verification is meaningful only for
 * `_drafts/`-prefixed paths since promotion is the only flow that
 * calls this.
 */

export interface CitationDriftReport {
  /** Total `cited_chunks` entries in the draft frontmatter. */
  total: number;
  /** Entries that resolve to a chunk currently in the index. */
  verified: number;
  /** Entries whose source note exists but whose chunk index is gone. */
  missingChunks: CitedChunk[];
  /** Entries whose source note doesn't exist in either engine anymore. */
  missingNotes: CitedChunk[];
  /** True iff `missingChunks` or `missingNotes` is non-empty. */
  hasDrift: boolean;
}

export interface VerifyCitationsOpts {
  adapter: VaultAdapter;
  draftPath: string;
  /** Sagittarius's own DB. */
  selfEngine: SqliteEngine;
  /** corpus-ingest's DB; checked when the chunk wasn't found in `self`. */
  corpusEngine?: SqliteEngine;
}

/**
 * Read the draft, parse `cited_chunks`, and verify each entry against
 * the index. Returns a `CitationDriftReport` with classified drift.
 *
 * Drafts without a `cited_chunks` array (or with `cited_chunks: []`)
 * report `total: 0, hasDrift: false` — no drift to detect.
 *
 * @example
 *   const report = await verifyCitations({
 *     adapter, draftPath: '_drafts/30-Projects/q3.md',
 *     selfEngine, corpusEngine,
 *   });
 *   if (report.hasDrift) { showWarning(report); }
 */
export async function verifyCitations(opts: VerifyCitationsOpts): Promise<CitationDriftReport> {
  if (!isDraftPath(opts.draftPath)) {
    throw new Error(
      `verifyCitations: '${opts.draftPath}' is not a draft path. ` +
        'Citation drift verification only applies to drafts under `_drafts/`.',
    );
  }
  const content = await opts.adapter.read(opts.draftPath);
  const { frontmatter } = splitFrontmatter(content);
  const cited = parseCitedChunks(frontmatter);
  const verified: CitedChunk[] = [];
  const missingChunks: CitedChunk[] = [];
  const missingNotes: CitedChunk[] = [];
  for (const entry of cited) {
    if (resolves(opts.selfEngine, entry) || (opts.corpusEngine !== undefined && resolves(opts.corpusEngine, entry))) {
      verified.push(entry);
      continue;
    }
    if (
      opts.selfEngine.countChunksForPath(entry.notePath) > 0 ||
      (opts.corpusEngine !== undefined && opts.corpusEngine.countChunksForPath(entry.notePath) > 0)
    ) {
      missingChunks.push(entry);
      continue;
    }
    missingNotes.push(entry);
  }
  return {
    total: cited.length,
    verified: verified.length,
    missingChunks,
    missingNotes,
    hasDrift: missingChunks.length > 0 || missingNotes.length > 0,
  };
}

/**
 * Render a one-line human-readable summary of a drift report. Used
 * by the promotion-path Notice / modal. Stable for snapshot tests.
 *
 * @example
 *   formatDriftSummary({ total: 5, verified: 3, missingChunks: [...], missingNotes: [...], hasDrift: true })
 *   // → 'citation drift: 3/5 verified · 1 missing chunk · 1 missing note'
 */
export function formatDriftSummary(report: CitationDriftReport): string {
  if (report.total === 0) {
    return 'no citations to verify';
  }
  if (!report.hasDrift) {
    return `all ${report.total} citation${report.total === 1 ? '' : 's'} verified`;
  }
  const parts: string[] = [`${report.verified}/${report.total} verified`];
  if (report.missingChunks.length > 0) {
    const n = report.missingChunks.length;
    parts.push(`${n} missing chunk${n === 1 ? '' : 's'}`);
  }
  if (report.missingNotes.length > 0) {
    const n = report.missingNotes.length;
    parts.push(`${n} missing note${n === 1 ? '' : 's'}`);
  }
  return `citation drift: ${parts.join(' · ')}`;
}

function resolves(engine: SqliteEngine, entry: CitedChunk): boolean {
  return engine.getChunk(entry.notePath, entry.chunkIndex) !== null;
}

/**
 * Parse the `cited_chunks: [...]` frontmatter array into typed
 * `CitedChunk` records. Tolerates partial/malformed entries — a row
 * missing `chunk` or with the wrong type is silently skipped (the
 * caller can't verify what they can't reconstruct).
 */
function parseCitedChunks(frontmatter: Record<string, unknown> | null): CitedChunk[] {
  if (frontmatter === null) {
    return [];
  }
  const raw = frontmatter.cited_chunks;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: CitedChunk[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const r = row as Record<string, unknown>;
    const note = r.note;
    const chunk = r.chunk;
    const score = r.score;
    if (typeof note !== 'string' || note.length === 0) {
      continue;
    }
    if (typeof chunk !== 'number' || !Number.isInteger(chunk) || chunk < 0) {
      continue;
    }
    out.push({
      notePath: note,
      chunkIndex: chunk,
      score: typeof score === 'number' ? score : 0,
    });
  }
  return out;
}
