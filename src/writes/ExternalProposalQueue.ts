import type { Decision, Proposal } from './types';

/**
 * Phase 6.7 (v1.1.0) — pending-proposal store for MCP-driven writes
 * per ADR-025 D2 (c) hybrid transport and D4 side-panel UX.
 *
 * The shared `CallbackApprovalGate` routes a proposal here whenever
 * the active `WriteToolContext.currentSource()` is non-undefined (i.e.
 * the write is from an external MCP client). Each enqueued proposal
 * returns a `Promise<Decision>` that resolves when something — the
 * external-proposals side panel, a unit test, the diff card —
 * calls `respond(id, decision)`.
 *
 * Pure JavaScript; no I/O, no UI dependencies. The view layer
 * subscribes via `onChange` to know when to re-render.
 *
 * Lifecycle of a single proposal:
 *   1. `enqueue(proposal, source)` returns a pending promise + new
 *       entry visible to `pending()` listeners.
 *   2. The side panel renders the entry; clicking Approve/Reject
 *      calls `respond(id, decision)`.
 *   3. `respond` resolves the promise (so the tool's apply() runs on
 *      accept) and removes the entry from the queue.
 *   4. Subscribers receive change notifications on enqueue + respond
 *      + clearAll.
 *
 * Concurrency note: the queue does NOT serialize transactions on the
 * shared `WriteToolContext`. McpHandler's existing block-at-begin
 * semantics still apply: if `ctx.begin()` throws because the in-app
 * chat is mid-turn, the MCP request never reaches the queue. The
 * queue is purely about the *user-approval* delay, not the
 * begin-commit lifecycle.
 */

export interface ExternalProposalEntry {
  /** Stable id used by the side panel + `respond`. Monotonic + sortable. */
  readonly id: string;
  /** The `Proposal` from the write tool. The view renders `diff` + `args`. */
  readonly proposal: Proposal;
  /**
   * Attribution from `WriteToolContext.currentSource()` — typically
   * `'mcp:<client>'`. Surfaced in the side panel header so the user
   * can see "Claude Desktop is asking to write" at a glance.
   */
  readonly source: string;
  /** Epoch ms when the proposal entered the queue. */
  readonly enqueuedAt: number;
}

export interface ExternalProposalQueueOptions {
  /** Injectable clock for tests. Returns epoch ms. */
  now?: () => number;
  /** Injectable id generator for tests. Must return a unique 6-hex-char string. */
  randId?: () => string;
}

export class ExternalProposalQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly randId: () => string;

  constructor(opts: ExternalProposalQueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.randId = opts.randId ?? defaultRandId;
  }

  /**
   * Enqueue a proposal and return a promise that resolves when
   * `respond(id, decision)` is called. The id is also exposed on the
   * resulting entry (visible via `pending()`).
   */
  enqueue(proposal: Proposal, source: string): Promise<Decision> {
    const enqueuedAt = this.now();
    const id = `${enqueuedAt}-${this.randId()}`;
    let resolve!: (d: Decision) => void;
    const promise = new Promise<Decision>((res) => {
      resolve = res;
    });
    const entry: QueueEntry = {
      id,
      proposal,
      source,
      enqueuedAt,
      resolve,
    };
    this.entries.set(id, entry);
    this.notify();
    return promise;
  }

  /**
   * Resolve a pending proposal with `decision`. Removes the entry.
   * Throws if `id` is unknown — silent drops would mask side-panel
   * bugs.
   */
  respond(id: string, decision: Decision): void {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(
        `ExternalProposalQueue.respond: no pending entry with id '${id}'. ` +
          `Already responded or never enqueued.`,
      );
    }
    this.entries.delete(id);
    entry.resolve(decision);
    this.notify();
  }

  /**
   * Snapshot of pending entries in enqueue order. Returns a new array
   * so callers can iterate without worrying about mutations during
   * iteration (e.g. another respond firing).
   */
  pending(): ExternalProposalEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map(({ resolve: _resolve, ...visible }) => visible);
  }

  /** Number of pending entries. Cheap; status bar can poll without cost. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Reject every pending entry with the supplied reason and clear the
   * queue. Used at plugin unload so promises don't dangle and the
   * MCP client gets actionable feedback instead of a hung tool call.
   */
  clearAll(reason: string): void {
    if (this.entries.size === 0) {
      return;
    }
    const snapshot = [...this.entries.values()];
    this.entries.clear();
    for (const entry of snapshot) {
      entry.resolve({ kind: 'reject', reason });
    }
    this.notify();
  }

  /**
   * Subscribe to enqueue / respond / clearAll events. Returns an
   * unsubscribe function. Callbacks receive no arguments — the view
   * re-reads `pending()` each notification.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    // Snapshot first so a listener that mutates the listener set during
    // iteration doesn't trip the iterator.
    const snapshot = [...this.listeners];
    for (const fn of snapshot) {
      try {
        fn();
      } catch (err) {
        // Listeners shouldn't throw — but if one does, the others must
        // still run. Surface via console because we have no logger dep.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ExternalProposalQueue] listener threw: ${message}`);
      }
    }
  }
}

interface QueueEntry extends ExternalProposalEntry {
  resolve: (decision: Decision) => void;
}

/** 6 hex chars (~24 bits of entropy) — collision-safe within a single ms. */
function defaultRandId(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}
