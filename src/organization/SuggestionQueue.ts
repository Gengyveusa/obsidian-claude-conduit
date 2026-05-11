import type { VaultAdapter } from '../agent/types';

import type { Suggestion } from './types';

/**
 * Append-only queue of proactive suggestions for the v0.6.0 organization
 * engine per [ADR-017](../../docs/2026-05-11-adr-017-phase-5-plan.md).
 *
 * Persists as a flat JSON array at `<plugin-data>/suggestions.json`.
 * Capped at `maxEntries` (default 200 per ADR-017 risk-mitigation table);
 * oldest fall off when the cap is hit. Suggestions are independent —
 * unlike Phase 4 transactions, there's no per-turn grouping. The queue
 * is the source of truth for the SuggestionsView panel.
 *
 * Lifecycle of a single suggestion:
 *   1. `OrganizationClassifier` produces a `Suggestion` after observing
 *      a vault event. Calls `queue.add(suggestion)` if the note isn't
 *      already in the queue (`hasForNote` dedup).
 *   2. `SuggestionsView` renders rows from `queue.list()`.
 *   3. User clicks Apply → panel runs the proposed write through Phase 4
 *      tools, then calls `queue.remove(id)` on success.
 *   4. User clicks Skip → panel calls `queue.remove(id)` directly.
 *   5. User clicks Defer → panel calls `queue.defer(id)`; suggestion stays
 *      in the queue but sorts to the bottom on next `list()`.
 *
 * @example
 *   const queue = new JsonSuggestionQueue({ adapter, path: '.obsidian/.../suggestions.json' });
 *   await queue.add({ kind: 'route', id: '1700000000000-abcdef', ...});
 *   const visible = await queue.list({ minConfidence: 0.6 });
 */
export interface SuggestionQueue {
  /**
   * Add a suggestion. No-op if a suggestion already exists for the same
   * note path (dedup); use `remove` first if you want to replace one.
   * Returns true if added, false if deduped.
   */
  add(suggestion: Suggestion): Promise<boolean>;

  /**
   * Return suggestions, sorted: non-deferred first (newest → oldest by
   * `createdAt`), then deferred (newest → oldest). Filtered by the optional
   * options:
   *   - `includeDeferred` (default true) — when false, deferred entries are dropped
   *   - `minConfidence` (default 0) — only include entries with `confidence >= this`
   */
  list(opts?: { includeDeferred?: boolean; minConfidence?: number }): Promise<Suggestion[]>;

  /**
   * Remove the suggestion with the given id. Returns the removed entry,
   * or null if no entry had that id.
   */
  remove(id: string): Promise<Suggestion | null>;

  /**
   * Mark a suggestion as deferred. Returns the updated entry, or null if
   * not found. Idempotent — deferring an already-deferred entry is a no-op.
   */
  defer(id: string): Promise<Suggestion | null>;

  /**
   * True if any suggestion in the queue references `notePath` as its primary
   * subject (`route.notePath` or `moc-add.notePath`). Used by the classifier
   * to dedup before building a fresh suggestion.
   */
  hasForNote(notePath: string): Promise<boolean>;

  /** Drop every suggestion. */
  clear(): Promise<void>;

  /** Total count, including deferred. Used by the ribbon icon's badge. */
  size(): Promise<number>;
}

export interface JsonSuggestionQueueOptions {
  adapter: VaultAdapter;
  /** Vault-relative path to the JSON file. */
  path: string;
  /** Cap; oldest entries fall off above this. Default 200 per ADR-017. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 200;

export class JsonSuggestionQueue implements SuggestionQueue {
  private readonly adapter: VaultAdapter;
  private readonly path: string;
  private readonly maxEntries: number;

  constructor(opts: JsonSuggestionQueueOptions) {
    this.adapter = opts.adapter;
    this.path = opts.path;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async add(suggestion: Suggestion): Promise<boolean> {
    const all = await this.loadAll();
    if (all.some((s) => s.notePath === suggestion.notePath)) {
      return false;
    }
    all.push(suggestion);
    const trimmed = all.length > this.maxEntries ? all.slice(-this.maxEntries) : all;
    await this.persist(trimmed);
    return true;
  }

  async list(
    opts: { includeDeferred?: boolean; minConfidence?: number } = {},
  ): Promise<Suggestion[]> {
    const all = await this.loadAll();
    const includeDeferred = opts.includeDeferred ?? true;
    const minConfidence = opts.minConfidence ?? 0;

    const filtered = all.filter(
      (s) => s.confidence >= minConfidence && (includeDeferred || s.deferred !== true),
    );

    // Non-deferred first (newest → oldest by createdAt), then deferred.
    return filtered.sort((a, b) => {
      const aDef = a.deferred === true ? 1 : 0;
      const bDef = b.deferred === true ? 1 : 0;
      if (aDef !== bDef) {
        return aDef - bDef;
      }
      return b.createdAt - a.createdAt;
    });
  }

  async remove(id: string): Promise<Suggestion | null> {
    const all = await this.loadAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) {
      return null;
    }
    const [removed] = all.splice(idx, 1);
    await this.persist(all);
    return removed;
  }

  async defer(id: string): Promise<Suggestion | null> {
    const all = await this.loadAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) {
      return null;
    }
    const updated: Suggestion = { ...all[idx], deferred: true };
    all[idx] = updated;
    await this.persist(all);
    return updated;
  }

  async hasForNote(notePath: string): Promise<boolean> {
    const all = await this.loadAll();
    return all.some((s) => s.notePath === notePath);
  }

  async clear(): Promise<void> {
    await this.adapter.write(this.path, '[]');
  }

  async size(): Promise<number> {
    const all = await this.loadAll();
    return all.length;
  }

  private async loadAll(): Promise<Suggestion[]> {
    if (!(await this.adapter.exists(this.path))) {
      return [];
    }
    const raw = await this.adapter.read(this.path);
    if (raw.trim().length === 0) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(
        `SuggestionQueue: ${this.path} contains non-array JSON. ` +
          'Either delete it (loses pending suggestions) or fix it by hand.',
      );
    }
    return parsed as Suggestion[];
  }

  private async persist(entries: Suggestion[]): Promise<void> {
    if (entries.length === 0) {
      // Persist an empty array rather than deleting the file — keeps the
      // contract simple ("the file is always JSON if it exists").
      await this.adapter.write(this.path, '[]');
      return;
    }
    await this.adapter.write(this.path, JSON.stringify(entries, null, 2));
  }
}
