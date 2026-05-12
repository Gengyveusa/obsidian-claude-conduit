import type { VaultAdapter } from '../agent/types';

import type { MocAddClassifier } from './MocAddClassifier';
import type { MocDiscovery } from './MocDiscovery';
import type { OrganizationClassifier } from './OrganizationClassifier';
import type { SuggestionQueue } from './SuggestionQueue';

/**
 * Phase 5 (Organization Engine) watcher per [ADR-017](../../docs/2026-05-11-adr-017-phase-5-plan.md) D1.
 *
 * Connects vault events → classifier → queue. Two entry points:
 *
 *   - **Event-driven**: subscribes to vault `create` events. When a file
 *     is created in a watched folder, debounces (default 5s) then
 *     classifies. The debounce avoids thrashing while the user is still
 *     typing into a fresh note.
 *
 *   - **Manual sweep**: `sweep()` enumerates every file in watched
 *     folders and classifies the ones not already in the queue. Used by
 *     the `Sagittarius: organize inbox now` command (wired in PR 4).
 *
 *   - **Cleanup**: subscribes to vault `delete` events. When a file is
 *     deleted, drop any stale queue entry for it (keeps the panel from
 *     showing suggestions for files the user already removed).
 *
 * The watcher itself does no LLM I/O — that's the classifier's job. It
 * just orchestrates: filter → dedup → classify → enqueue.
 *
 * @example
 *   const watcher = new OrganizationWatcher({ classifier, queue, ... });
 *   watcher.start();   // begin event subscription
 *   // ... user creates a note in 10-Inbox/, watcher debounces 5s, classifies,
 *   //     enqueues. Panel shows it.
 *   watcher.stop();    // unsubscribe
 */
export interface VaultEventEmitter {
  /** Subscribe to file-create events. Returns an unsubscribe function. */
  onCreate(handler: (path: string) => void): () => void;
  /** Subscribe to file-delete events. Returns an unsubscribe function. */
  onDelete(handler: (path: string) => void): () => void;
}

export interface OrganizationWatcherDeps {
  classifier: OrganizationClassifier;
  queue: SuggestionQueue;
  events: VaultEventEmitter;
  adapter: VaultAdapter;
  /**
   * Optional v0.6.x moc-add pair. Both must be supplied to enable
   * moc-add suggestions; if either is omitted, the watcher skips the
   * moc-add code path silently. main.ts wires these only when the
   * user has populated `organizationMocFolders` in settings.
   */
  mocAddClassifier?: MocAddClassifier;
  mocDiscovery?: MocDiscovery;
  /** Initial config. `setEnabled` / `setWatchedFolders` can update at runtime. */
  enabled: boolean;
  watchedFolders: string[];
  /** Confidence threshold; suggestions below this are still added (queue filters at list time). */
  minConfidence?: number;
  /** Debounce per-path before classification fires. Default 5000ms per ADR-017 D1. */
  debounceMs?: number;
  /** Test-injectable for fast / deterministic tests. */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  logger?: { warn: (msg: string) => void };
}

export interface ClassifyOutcome {
  /** True if a classifier call ran and a suggestion was added. */
  enqueued: boolean;
  /** Skip reason, populated when `enqueued` is false. */
  skipped?:
    | 'disabled'
    | 'not-in-watched-folder'
    | 'already-in-queue'
    | 'classifier-said-keep'
    | 'classifier-error';
  /** Error message when `skipped === 'classifier-error'`. */
  error?: string;
}

export interface SweepOutcome {
  classified: number;
  skipped: number;
  errors: number;
}

const DEFAULT_DEBOUNCE_MS = 5000;

export class OrganizationWatcher {
  private enabled: boolean;
  private watchedFolders: string[];
  private readonly minConfidence: number;
  private readonly debounceMs: number;
  private readonly setTimeoutImpl: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly logger: { warn: (msg: string) => void };

  /** Active debounce timers keyed by path. Cleared when classification fires. */
  private readonly pendingTimers = new Map<string, unknown>();
  /** Active subscriptions; cleared on stop(). */
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: OrganizationWatcherDeps) {
    this.enabled = deps.enabled;
    this.watchedFolders = deps.watchedFolders.map(stripTrailingSlash);
    this.minConfidence = deps.minConfidence ?? 0;
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutImpl =
      deps.clearTimeoutImpl ?? ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.logger = deps.logger ?? { warn: (msg) => console.warn(`[org-watcher] ${msg}`) };
  }

  /** Subscribe to vault events. Idempotent — calling start twice is safe. */
  start(): void {
    if (this.unsubscribers.length > 0) {
      return;
    }
    this.unsubscribers.push(
      this.deps.events.onCreate((path) => {
        this.scheduleClassification(path);
      }),
    );
    this.unsubscribers.push(
      this.deps.events.onDelete((path) => {
        // Fire-and-forget — best-effort dedup cleanup.
        void this.removeFromQueueByPath(path);
      }),
    );
  }

  /** Unsubscribe + cancel any pending debounce timers. */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch {
        // Swallow — unsubscribe should never throw, but if it does we
        // still want to clear the rest.
      }
    }
    this.unsubscribers = [];
    for (const handle of this.pendingTimers.values()) {
      this.clearTimeoutImpl(handle);
    }
    this.pendingTimers.clear();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Clear pending timers but leave subscriptions alone (cheap; flips back fast).
      for (const handle of this.pendingTimers.values()) {
        this.clearTimeoutImpl(handle);
      }
      this.pendingTimers.clear();
    }
  }

  setWatchedFolders(folders: string[]): void {
    this.watchedFolders = folders.map(stripTrailingSlash);
  }

  /**
   * Manually classify one note. Used both internally (after debounce
   * fires) and by tests / sweep. Returns an outcome describing what
   * happened — no exceptions for normal flow (skip cases). Classifier
   * failures are caught + logged + reported as `classifier-error`.
   */
  async classifyNote(path: string): Promise<ClassifyOutcome> {
    if (!this.enabled) {
      return { enqueued: false, skipped: 'disabled' };
    }
    if (!this.isInWatchedFolder(path)) {
      return { enqueued: false, skipped: 'not-in-watched-folder' };
    }
    if (await this.deps.queue.hasForNote(path)) {
      return { enqueued: false, skipped: 'already-in-queue' };
    }

    let outcome;
    try {
      outcome = await this.deps.classifier.classifyForRoute(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`classify ${path} failed: ${msg}`);
      return { enqueued: false, skipped: 'classifier-error', error: msg };
    }

    if (outcome.suggestion === null) {
      // Route classifier said KEEP. Try moc-add: maybe the note belongs
      // on an existing MOC. Per ADR-017 D6, moc-add only runs in the
      // KEEP branch — notes that are about to move don't need MOC
      // membership computed yet (PR 3 v0.6.x integration).
      return this.tryMocAdd(path);
    }
    if (outcome.suggestion.confidence < this.minConfidence) {
      // Still enqueue — the panel filters at display time so users can
      // toggle "show low-confidence" without re-running the classifier.
      // No special skip — the entry just won't be visible by default.
    }
    await this.deps.queue.add(outcome.suggestion);
    return { enqueued: true };
  }

  /**
   * v0.6.x extension — run the moc-add classifier on a note that the
   * route classifier already decided to KEEP. Returns a `ClassifyOutcome`:
   *
   *   - `classifier-said-keep` when moc-add is not configured (either
   *     dep missing or no MOC candidates discovered) OR the classifier
   *     said NONE. This keeps the outcome vocabulary stable — callers
   *     don't need to know whether moc-add was even attempted.
   *   - `enqueued: true` when a moc-add suggestion was added.
   *   - `classifier-error` when the moc-add classifier threw.
   */
  private async tryMocAdd(path: string): Promise<ClassifyOutcome> {
    const mocClassifier = this.deps.mocAddClassifier;
    const mocDiscovery = this.deps.mocDiscovery;
    if (mocClassifier === undefined || mocDiscovery === undefined) {
      return { enqueued: false, skipped: 'classifier-said-keep' };
    }

    let candidates;
    try {
      candidates = await mocDiscovery.discover();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`MOC discovery for ${path} failed: ${msg}`);
      return { enqueued: false, skipped: 'classifier-error', error: msg };
    }
    if (candidates.length === 0) {
      return { enqueued: false, skipped: 'classifier-said-keep' };
    }

    let mocOutcome;
    try {
      mocOutcome = await mocClassifier.classifyForMocAdd(path, candidates);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`moc-add classify ${path} failed: ${msg}`);
      return { enqueued: false, skipped: 'classifier-error', error: msg };
    }

    if (mocOutcome.suggestion === null) {
      return { enqueued: false, skipped: 'classifier-said-keep' };
    }
    await this.deps.queue.add(mocOutcome.suggestion);
    return { enqueued: true };
  }

  /**
   * Walk every watched folder and classify files not already in the
   * queue. Used by the manual `Sagittarius: organize inbox now` command.
   * Returns counts so the command's Notice can show a summary.
   */
  async sweep(): Promise<SweepOutcome> {
    if (!this.enabled) {
      return { classified: 0, skipped: 0, errors: 0 };
    }
    let classified = 0;
    let skipped = 0;
    let errors = 0;

    for (const folder of this.watchedFolders) {
      const files = await this.listFolderRecursive(folder);
      for (const path of files) {
        const outcome = await this.classifyNote(path);
        if (outcome.enqueued) {
          classified++;
        } else if (outcome.skipped === 'classifier-error') {
          errors++;
        } else {
          skipped++;
        }
      }
    }

    return { classified, skipped, errors };
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private scheduleClassification(path: string): void {
    if (!this.enabled) {
      return;
    }
    if (!this.isInWatchedFolder(path)) {
      return;
    }
    // Cancel any in-flight timer for this path so rapid re-events extend
    // the debounce window rather than firing N classifications.
    const existing = this.pendingTimers.get(path);
    if (existing !== undefined) {
      this.clearTimeoutImpl(existing);
    }
    const handle = this.setTimeoutImpl(() => {
      this.pendingTimers.delete(path);
      void this.classifyNote(path);
    }, this.debounceMs);
    this.pendingTimers.set(path, handle);
  }

  private isInWatchedFolder(path: string): boolean {
    if (this.watchedFolders.length === 0) {
      return false;
    }
    return this.watchedFolders.some(
      (folder) => folder === '' || path.startsWith(`${folder}/`),
    );
  }

  /**
   * Recursive walk of `folder` returning every `.md` file path. Uses
   * `adapter.listAllMarkdown()` filtered by prefix — cheap (canonical
   * Obsidian API per ADR-015) and avoids the recursive `list()` quirks.
   */
  private async listFolderRecursive(folder: string): Promise<string[]> {
    const all = await this.deps.adapter.listAllMarkdown();
    if (folder === '') {
      return all;
    }
    const prefix = `${folder}/`;
    return all.filter((p) => p.startsWith(prefix));
  }

  private async removeFromQueueByPath(path: string): Promise<void> {
    // Find by notePath — we don't carry the suggestion id at this point.
    // List + filter + remove. Cheap because the queue is small (cap 200).
    try {
      const all = await this.deps.queue.list({ includeDeferred: true });
      for (const s of all) {
        if (s.notePath === path) {
          await this.deps.queue.remove(s.id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`failed to clean queue for deleted ${path}: ${msg}`);
    }
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
