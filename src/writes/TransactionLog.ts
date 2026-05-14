import type { ActivityLog } from '../activity/ActivityLog';
import type { VaultAdapter } from '../agent/types';

import type { AppliedOp, Transaction } from './types';

/**
 * Append-only transaction log for Phase 4 write tools.
 *
 * Per ADR-016 D3, the unit of undo is one agent turn — i.e. every approved
 * write op from a single LLM message commits as one `Transaction` whose
 * inverse ops can be replayed in reverse to undo the whole turn.
 *
 * Storage is a flat JSON array at `<basePath>/transactions.json` under the
 * plugin's data dir (`.obsidian/plugins/obsidian-claude-conduit/`). Cap is
 * configurable; default 1000. Oldest entries fall off when the cap is hit.
 *
 * @example
 *   const log = new JsonTransactionLog({ adapter, path: '.obsidian/plugins/obsidian-claude-conduit/transactions.json' });
 *   const tx = log.begin('session-abc');
 *   tx.record({ toolName: 'create_note', path: 'foo.md', appliedAt: nowSec(), inverse: { kind: 'delete-file', path: 'foo.md' } });
 *   await tx.commit();  // persists; returns the finalized Transaction
 */
export interface TransactionLog {
  /**
   * Open a new transaction. `source` is recorded on the resulting
   * `Transaction` (and propagated to `write.committed` activity events)
   * per ADR-025 D5 — set it to `'mcp:<client>'` when opening on behalf
   * of an external MCP caller. Omit for in-app chat turns.
   */
  begin(sessionId?: string, source?: string): TransactionBuilder;
  recent(limit?: number): Promise<Transaction[]>;
  /**
   * Pop the most-recent transaction off the log and persist the result.
   * Returns the removed transaction, or null if the log was already empty.
   * Used by the v0.4.0 `undo_last_transaction` command after a successful
   * inverse-op replay.
   */
  removeLast(): Promise<Transaction | null>;
}

export interface TransactionBuilder {
  /** Add an op to the pending transaction. Order matters — committed in insertion order. */
  record(op: AppliedOp): void;
  /** Persist the transaction. Empty transactions (no ops recorded) are dropped silently. */
  commit(): Promise<Transaction | null>;
  /** User rejected the whole turn — discard without persisting. Idempotent. */
  abandon(): void;
}

export interface JsonTransactionLogOptions {
  adapter: VaultAdapter;
  /** Vault-relative path to the JSON file. */
  path: string;
  /** Cap; oldest entries fall off above this. Default 1000 per ADR-016 risk mitigation. */
  maxEntries?: number;
  /** Injectable clock for tests. Returns epoch ms. */
  now?: () => number;
  /** Injectable RNG for tests; must return 6 hex chars. */
  randId?: () => string;
  /**
   * Phase 6 (v0.8.0) — when supplied, every committed write op also emits
   * a `write.committed` event for the activity stream. Optional so tests
   * that don't care about activity can omit it.
   */
  activityLog?: ActivityLog;
}

const DEFAULT_MAX_ENTRIES = 1000;

export class JsonTransactionLog implements TransactionLog {
  private readonly adapter: VaultAdapter;
  private readonly path: string;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly randId: () => string;
  private readonly activityLog?: ActivityLog;

  constructor(opts: JsonTransactionLogOptions) {
    this.adapter = opts.adapter;
    this.path = opts.path;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
    this.randId = opts.randId ?? defaultRandId;
    if (opts.activityLog !== undefined) {
      this.activityLog = opts.activityLog;
    }
  }

  begin(sessionId?: string, source?: string): TransactionBuilder {
    const startMs = this.now();
    const id = `${startMs}-${this.randId()}`;
    const ops: AppliedOp[] = [];
    let abandoned = false;

    return {
      record: (op) => {
        if (abandoned) {
          throw new Error('TransactionBuilder.record() called after abandon()');
        }
        ops.push(op);
      },
      commit: async () => {
        if (abandoned) {
          throw new Error('TransactionBuilder.commit() called after abandon()');
        }
        if (ops.length === 0) {
          return null;
        }
        const tx: Transaction = {
          id,
          timestamp: Math.floor(startMs / 1000),
          ...(sessionId !== undefined && { sessionId }),
          ...(source !== undefined && { source }),
          ops: [...ops],
        };
        await this.appendAndPersist(tx);
        return tx;
      },
      abandon: () => {
        abandoned = true;
      },
    };
  }

  async recent(limit?: number): Promise<Transaction[]> {
    const all = await this.loadAll();
    if (limit === undefined) {
      return all;
    }
    return all.slice(-limit);
  }

  async removeLast(): Promise<Transaction | null> {
    const all = await this.loadAll();
    if (all.length === 0) {
      return null;
    }
    const removed = all[all.length - 1];
    const remaining = all.slice(0, -1);
    if (remaining.length === 0) {
      // Persist an empty array rather than deleting the file — keeps the
      // contract simple ("the file is always JSON if it exists") and avoids
      // a needless adapter.delete dance here.
      await this.adapter.write(this.path, '[]');
    } else {
      await this.adapter.write(this.path, JSON.stringify(remaining, null, 2));
    }
    return removed;
  }

  private async appendAndPersist(tx: Transaction): Promise<void> {
    const existing = await this.loadAll();
    existing.push(tx);
    const trimmed =
      existing.length > this.maxEntries
        ? existing.slice(existing.length - this.maxEntries)
        : existing;
    await this.adapter.write(this.path, JSON.stringify(trimmed, null, 2));
    if (this.activityLog !== undefined) {
      for (const op of tx.ops) {
        await this.activityLog.record({
          kind: 'write.committed',
          toolName: op.toolName,
          path: op.path,
          ...(tx.source !== undefined && { source: tx.source }),
        });
      }
    }
  }

  private async loadAll(): Promise<Transaction[]> {
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
        `TransactionLog: ${this.path} contains non-array JSON. ` +
          `Either delete it (loses undo history) or fix it by hand.`,
      );
    }
    // We trust the on-disk shape — it was written by us. If it ever fails
    // at runtime we'll learn from a thrown TypeError; that's the right
    // signal to add a Zod validator here.
    return parsed as Transaction[];
  }
}

/** 6 hex chars (~24 bits of entropy) — collision-safe within a single ms. */
function defaultRandId(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}
