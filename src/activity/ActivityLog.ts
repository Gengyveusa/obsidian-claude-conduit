import type { VaultAdapter } from '../agent/types';

import type { ActivityEvent, ActivityEventInput, ActivityEventKind } from './types';

/**
 * Phase 6 (v0.8.0) activity stream per
 * [ADR-019](../../docs/2026-05-12-adr-019-phase-6-plan.md) D4.
 *
 * Append-only log of every observable thing Sagittarius does
 * (classifier calls, suggestions, writes, errors). Persists as a flat
 * JSON array at `<plugin-data>/activity.json`. Capped at `maxEntries`
 * (default 1000 per ADR-019 D4); oldest fall off when the cap is hit.
 *
 * Lifecycle:
 *   1. Subsystem (watcher, classifier, write tool, etc.) calls
 *      `log.record({ kind: 'classifier.ran', ... })` with the event
 *      payload sans `id` / `timestamp` — the log fills those in.
 *   2. `ActivityView` polls `log.list()` and renders.
 *   3. Diagnostics command (v0.8.1) reads `log.list({ limit: 50 })`
 *      and dumps state.
 *
 * @example
 *   const log = new JsonActivityLog({ adapter, path: '.obsidian/.../activity.json' });
 *   await log.record({
 *     kind: 'classifier.ran',
 *     notePath: '10-Inbox/draft.md',
 *     model: 'claude-sonnet-4-6',
 *     outcome: 'route',
 *     confidence: 0.93,
 *     durationMs: 1284,
 *   });
 *   const recent = await log.list({ limit: 20 });
 */
export interface ActivityLog {
  /**
   * Append an event. The log auto-populates `id` and `timestamp`. Returns
   * the persisted event (with those fields filled in) so callers can
   * cross-reference (e.g., a write tool can record the event id alongside
   * its transaction).
   */
  record(input: ActivityEventInput): Promise<ActivityEvent>;

  /**
   * Return events, newest first. Filter by:
   *   - `limit` — max entries returned (default: unbounded)
   *   - `kinds` — only include events whose `kind` is in this set
   *   - `sinceMs` — only include events with `timestamp >= sinceMs`
   *     (Date.now()-style milliseconds)
   */
  list(opts?: {
    limit?: number;
    kinds?: ActivityEventKind[];
    sinceMs?: number;
  }): Promise<ActivityEvent[]>;

  /** Total count. Used by the "N events" header in the view. */
  size(): Promise<number>;

  /** Drop every event. */
  clear(): Promise<void>;
}

export interface JsonActivityLogOptions {
  adapter: VaultAdapter;
  /** Vault-relative path to the JSON file. */
  path: string;
  /** Cap; oldest entries fall off above this. Default 1000 per ADR-019 D4. */
  maxEntries?: number;
  /** Test-injectable clock + id generator. */
  now?: () => number;
  randomSuffix?: () => string;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class JsonActivityLog implements ActivityLog {
  private readonly adapter: VaultAdapter;
  private readonly path: string;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly randomSuffix: () => string;

  constructor(opts: JsonActivityLogOptions) {
    this.adapter = opts.adapter;
    this.path = opts.path;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? (() => Date.now());
    this.randomSuffix = opts.randomSuffix ?? defaultRandomSuffix;
  }

  async record(input: ActivityEventInput): Promise<ActivityEvent> {
    const timestamp = this.now();
    const event: ActivityEvent = {
      ...input,
      id: `${timestamp}-${this.randomSuffix()}`,
      timestamp,
    };
    const all = await this.loadAll();
    all.push(event);
    const trimmed = all.length > this.maxEntries ? all.slice(-this.maxEntries) : all;
    await this.persist(trimmed);
    return event;
  }

  async list(
    opts: { limit?: number; kinds?: ActivityEventKind[]; sinceMs?: number } = {},
  ): Promise<ActivityEvent[]> {
    const all = await this.loadAll();
    let filtered = all;
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      const kindSet = new Set(opts.kinds);
      filtered = filtered.filter((e) => kindSet.has(e.kind));
    }
    if (opts.sinceMs !== undefined) {
      const since = opts.sinceMs;
      filtered = filtered.filter((e) => e.timestamp >= since);
    }
    // Newest first.
    filtered = filtered.slice().sort((a, b) => b.timestamp - a.timestamp);
    if (opts.limit !== undefined && opts.limit >= 0) {
      filtered = filtered.slice(0, opts.limit);
    }
    return filtered;
  }

  async size(): Promise<number> {
    const all = await this.loadAll();
    return all.length;
  }

  async clear(): Promise<void> {
    await this.adapter.write(this.path, '[]');
  }

  private async loadAll(): Promise<ActivityEvent[]> {
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
        `ActivityLog: ${this.path} contains non-array JSON. ` +
          'Either delete it (loses history) or fix it by hand.',
      );
    }
    return parsed as ActivityEvent[];
  }

  private async persist(entries: ActivityEvent[]): Promise<void> {
    if (entries.length === 0) {
      await this.adapter.write(this.path, '[]');
      return;
    }
    await this.adapter.write(this.path, JSON.stringify(entries, null, 2));
  }
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
