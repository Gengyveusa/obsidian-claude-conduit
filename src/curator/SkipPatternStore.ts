import type { VaultAdapter } from '../agent/types';

/**
 * Phase 7 v1.0.5 — `SkipPatternStore` per
 * [ADR-022 D7](../../docs/2026-05-13-adr-022-phase-7-curator-plan.md)
 * (trust-calibration loop).
 *
 * When a user Skips a curator-derived suggestion, we want to remember
 * that they don't want to see this kind of finding for this path again.
 * The next sweep pre-filters any suggestion whose `(kind, notePath)`
 * matches a stored signature — same `kind` and the note's path
 * `startsWith` the stored `pathPrefix`.
 *
 * **Signature shape** — `{ kind, pathPrefix }`:
 *   - `kind`: the `Suggestion.kind` (e.g. `'add-frontmatter'`,
 *     `'archive-stale'`). Suggestion kind, not curator rule name, so
 *     the filter operates at the UI-visible granularity.
 *   - `pathPrefix`: a vault-relative path prefix. The default `Skip`
 *     action records `pathPrefix = suggestion.notePath` (exact-match
 *     for that note). Future UI passes can widen to a folder
 *     (`'10-Inbox/'`) to skip all suggestions of a kind under that
 *     folder.
 *
 * **Persistence** — one JSON file under the plugin data dir
 * (`<plugin-data>/curator-skip-patterns.json`), same convention as
 * `SuggestionQueue` and `ActivityLog`. Lazy-loaded on first call;
 * write-through on every mutation.
 *
 * @example
 *   const store = new JsonSkipPatternStore({ adapter, path: '.../skip.json' });
 *   await store.record('add-frontmatter', '10-Inbox/draft.md');
 *   await store.matches('add-frontmatter', '10-Inbox/draft.md'); // → true
 *   await store.matches('archive-stale', '10-Inbox/draft.md');   // → false
 */
export interface SkipPatternSignature {
  /** Suggestion kind, e.g. `'add-frontmatter'`. */
  kind: string;
  /**
   * Vault-relative path or path prefix. Matches via
   * `notePath.startsWith(pathPrefix)` — so `'10-Inbox/'` is a folder
   * scope, `'10-Inbox/draft.md'` is a single-note scope.
   */
  pathPrefix: string;
}

export interface SkipPatternStore {
  /** Record a new signature. No-op if `(kind, pathPrefix)` exact match already exists. */
  record(kind: string, pathPrefix: string): Promise<void>;
  /** True iff any stored signature matches `(kind, notePath)`. */
  matches(kind: string, notePath: string): Promise<boolean>;
  /** Return all stored signatures, in insertion order. */
  signatures(): Promise<SkipPatternSignature[]>;
  /** Remove the signature at `index`. Out-of-range = no-op. */
  remove(index: number): Promise<void>;
  /** Drop every stored signature. */
  clear(): Promise<void>;
}

export interface JsonSkipPatternStoreOptions {
  adapter: VaultAdapter;
  /** Vault-relative path to the JSON file. */
  path: string;
}

export class JsonSkipPatternStore implements SkipPatternStore {
  private readonly adapter: VaultAdapter;
  private readonly path: string;

  constructor(opts: JsonSkipPatternStoreOptions) {
    this.adapter = opts.adapter;
    this.path = opts.path;
  }

  async record(kind: string, pathPrefix: string): Promise<void> {
    const all = await this.loadAll();
    if (all.some((s) => s.kind === kind && s.pathPrefix === pathPrefix)) {
      return;
    }
    all.push({ kind, pathPrefix });
    await this.persist(all);
  }

  async matches(kind: string, notePath: string): Promise<boolean> {
    const all = await this.loadAll();
    for (const sig of all) {
      if (sig.kind === kind && notePath.startsWith(sig.pathPrefix)) {
        return true;
      }
    }
    return false;
  }

  async signatures(): Promise<SkipPatternSignature[]> {
    return this.loadAll();
  }

  async remove(index: number): Promise<void> {
    const all = await this.loadAll();
    if (index < 0 || index >= all.length) {
      return;
    }
    all.splice(index, 1);
    await this.persist(all);
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }

  private async loadAll(): Promise<SkipPatternSignature[]> {
    if (!(await this.adapter.exists(this.path))) {
      return [];
    }
    const raw = await this.adapter.read(this.path);
    if (raw.trim().length === 0) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted file — start over rather than crash the sweep.
      await this.persist([]);
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: SkipPatternSignature[] = [];
    for (const item of parsed) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'kind' in item &&
        'pathPrefix' in item &&
        typeof (item as { kind: unknown }).kind === 'string' &&
        typeof (item as { pathPrefix: unknown }).pathPrefix === 'string'
      ) {
        out.push({
          kind: (item as { kind: string }).kind,
          pathPrefix: (item as { pathPrefix: string }).pathPrefix,
        });
      }
    }
    return out;
  }

  private async persist(all: SkipPatternSignature[]): Promise<void> {
    await this.adapter.write(this.path, JSON.stringify(all, null, 2));
  }
}
