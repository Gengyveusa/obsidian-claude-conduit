import type { TransactionBuilder, TransactionLog } from './TransactionLog';
import type { AppliedOp, Transaction } from './types';

/**
 * Per-turn lifecycle wrapper around a `TransactionLog`. Lets the
 * `ConduitAgent` open one transaction per chat turn, while keeping the
 * write tools' API simple — they just call `ctx.record(op)` when they
 * apply, without needing to know whether a transaction is open or how to
 * get a builder.
 *
 * Lifecycle, enforced by the methods below:
 *   begin() → [record() | record() | ...] → end()
 *
 * Re-entry (begin without intervening end) throws. Calling record() or
 * end() outside an open transaction throws. These fail loud so we surface
 * misuse during development rather than silently dropping writes from the
 * undo log.
 *
 * @example
 *   const ctx = new WriteToolContext(txLog);
 *   ctx.begin(sessionId);
 *   // ... tools call ctx.record(op) during the turn
 *   await ctx.end();  // commits if any ops recorded; returns null if not
 */
export class WriteToolContext {
  private builder: TransactionBuilder | null = null;

  constructor(private readonly txLog: TransactionLog) {}

  /** Open a transaction for this turn. Throws if already open. */
  begin(sessionId?: string): void {
    if (this.builder !== null) {
      throw new Error(
        'WriteToolContext.begin: a transaction is already open. ' +
          'Call end() before opening another. Likely cause: a chat() ' +
          'call threw mid-loop without unwinding.',
      );
    }
    this.builder = this.txLog.begin(sessionId);
  }

  /** Record an applied op into the current transaction. Throws if no transaction is open. */
  record(op: AppliedOp): void {
    if (this.builder === null) {
      throw new Error(
        'WriteToolContext.record: no transaction is open. ' +
          'A write tool was invoked outside ConduitAgent.chat() — ' +
          'either a wiring bug or a test missed calling begin().',
      );
    }
    this.builder.record(op);
  }

  /**
   * Close the current transaction. Commits if any ops were recorded;
   * returns null and persists nothing if not. Throws if no transaction
   * is open. Resets state so the next begin() succeeds.
   */
  async end(): Promise<Transaction | null> {
    if (this.builder === null) {
      throw new Error('WriteToolContext.end: no transaction is open.');
    }
    const result = await this.builder.commit();
    this.builder = null;
    return result;
  }

  /**
   * Abandon the current transaction without committing. Used when a chat
   * turn aborts (e.g. the user closed the chat panel before any tool
   * applied). Resets state so the next begin() succeeds. Idempotent —
   * no-ops if no transaction is open.
   */
  abandon(): void {
    if (this.builder === null) {
      return;
    }
    this.builder.abandon();
    this.builder = null;
  }

  /** True if a transaction is open. */
  isOpen(): boolean {
    return this.builder !== null;
  }
}
