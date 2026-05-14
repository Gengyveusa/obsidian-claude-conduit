import type { VaultAdapter } from '../agent/types';
import { splitFrontmatter } from '../util/frontmatter';

import { DRAFTS_ROOT, isDraftPath } from './paths';

/**
 * Phase 8 (v1.2.0) — discovery + metadata layer for the Drafts side
 * panel per ADR-026 D5 (a).
 *
 * The store is read-only: it enumerates files under `_drafts/` via the
 * `VaultAdapter` and parses each draft's YAML frontmatter into a typed
 * `DraftRecord`. Writes (promote, discard) happen via the existing
 * tool registry on the plugin layer — the store is just the listing.
 *
 * Frontmatter is shape-checked: we accept whatever's on disk (the
 * user might have hand-edited a draft), so missing / wrong-type
 * fields degrade to `null` rather than throwing. The "is this a
 * draft" signal is purely path-based (`_drafts/` prefix); the
 * `quarantine: true` flag we write is an audit hint, not a gate.
 */

export interface DraftRecord {
  /** Vault-relative path (under `_drafts/`). */
  path: string;
  /** Topic the user typed into `NewDraftModal`. `null` if frontmatter is missing/malformed. */
  topic: string | null;
  /** Drafting model that produced this draft. `null` if missing. */
  draftingModel: string | null;
  /** Epoch-seconds timestamp from frontmatter, or `null`. */
  generatedAt: number | null;
  /** Count of `cited_chunks: [...]` entries. `0` if none / missing. */
  citedChunksCount: number;
  /** First-heading line for fall-back display when `topic` is null. */
  firstHeading: string | null;
  /** Byte size of the draft file. Used for "is this empty?" hints. */
  sizeBytes: number;
}

export interface DraftStoreDeps {
  adapter: VaultAdapter;
}

export class DraftStore {
  constructor(private readonly deps: DraftStoreDeps) {}

  /**
   * Enumerate every markdown file under `_drafts/` and return a
   * `DraftRecord[]` sorted newest-first by `generatedAt` (records
   * without a timestamp sort last, then alphabetic by path).
   *
   * Each call hits the adapter — fine because the side panel
   * re-renders on demand and the count is bounded (drafts are
   * meant to be small in number).
   */
  async list(): Promise<DraftRecord[]> {
    const allMd = await this.deps.adapter.listAllMarkdown();
    const draftPaths = allMd.filter((p) => isDraftPath(p));
    const records = await Promise.all(draftPaths.map((p) => this.loadRecord(p)));
    return records.sort((a, b) => this.compareRecords(a, b));
  }

  /** Snapshot count without parsing frontmatter. Used by the status bar pill. */
  async size(): Promise<number> {
    const allMd = await this.deps.adapter.listAllMarkdown();
    return allMd.filter((p) => isDraftPath(p)).length;
  }

  /** Load one record by path. Tolerates missing/malformed frontmatter. */
  async loadRecord(path: string): Promise<DraftRecord> {
    if (!isDraftPath(path)) {
      throw new Error(
        `DraftStore.loadRecord: '${path}' is not under ${DRAFTS_ROOT}. ` +
          'Drafts are quarantined; the store only loads paths under that prefix.',
      );
    }
    const content = await this.deps.adapter.read(path);
    const { frontmatter, body } = splitFrontmatter(content);
    return {
      path,
      topic: stringField(frontmatter, 'topic'),
      draftingModel: stringField(frontmatter, 'drafting_model'),
      generatedAt: numberField(frontmatter, 'generated_at'),
      citedChunksCount: countCitedChunks(frontmatter),
      firstHeading: firstHeading(body),
      sizeBytes: content.length,
    };
  }

  private compareRecords(a: DraftRecord, b: DraftRecord): number {
    if (a.generatedAt !== null && b.generatedAt !== null) {
      return b.generatedAt - a.generatedAt;
    }
    if (a.generatedAt !== null) {
      return -1;
    }
    if (b.generatedAt !== null) {
      return 1;
    }
    return a.path.localeCompare(b.path);
  }
}

function stringField(
  frontmatter: Record<string, unknown> | null,
  key: string,
): string | null {
  if (frontmatter === null) {
    return null;
  }
  const v = frontmatter[key];
  if (typeof v !== 'string' || v.length === 0) {
    return null;
  }
  return v;
}

function numberField(
  frontmatter: Record<string, unknown> | null,
  key: string,
): number | null {
  if (frontmatter === null) {
    return null;
  }
  const v = frontmatter[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return null;
  }
  return v;
}

function countCitedChunks(frontmatter: Record<string, unknown> | null): number {
  if (frontmatter === null) {
    return 0;
  }
  const v = frontmatter.cited_chunks;
  if (!Array.isArray(v)) {
    return 0;
  }
  return v.length;
}

function firstHeading(body: string): string | null {
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/^#+\s*/, '').trim() || null;
    }
    if (trimmed.length > 0) {
      // Hit non-heading content before a heading — no heading exists.
      return null;
    }
  }
  return null;
}
