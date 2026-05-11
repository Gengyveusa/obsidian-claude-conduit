import type { VaultAdapter } from '../agent/types';

import type { TransactionLog } from './TransactionLog';
import type { AppliedOp, InverseOp, Transaction } from './types';

/**
 * Per-op outcome from an `undo()` replay. Either the inverse applied
 * successfully (`ok: true`) or it failed with a captured error message.
 */
export interface UndoOpOutcome {
  toolName: string;
  path: string;
  inverse: InverseOp;
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
}

/**
 * Result of one `undo()` call. The shape lets callers (UI + tests) tell
 * three things at a glance:
 *
 *   - `transaction` — what was popped from the log (or null if nothing to undo)
 *   - `outcomes` — per-op success/failure, in REVERSE apply order
 *     (i.e. the order they were replayed)
 *   - `removedFromLog` — true only when every inverse succeeded; partial
 *     failures leave the transaction in place so the user can retry.
 */
export interface UndoResult {
  transaction: Transaction | null;
  outcomes: UndoOpOutcome[];
  removedFromLog: boolean;
}

/**
 * Pure replay loop that reverses the most recent transaction in a
 * `TransactionLog`. Pulls the tail transaction, applies its `inverse`s
 * in **reverse insertion order** (last-applied is first-undone), and
 * — if every inverse succeeded — pops the transaction off the log.
 *
 * On any per-op failure: abort, leave the transaction in the log so the
 * user can fix the underlying issue and retry. The successful inverses
 * stay applied (we don't roll forward partial work — the *forward* of
 * an inverse isn't always reversible, and we explicitly punted on
 * "transactional within undo" semantics per ADR-016 D5 amendment).
 *
 * @example
 *   const replayer = new TransactionReplayer({ adapter, log });
 *   const result = await replayer.undo();
 *   if (result.transaction === null) {
 *     new Notice('Nothing to undo.');
 *   } else if (result.removedFromLog) {
 *     new Notice(`Undid ${result.outcomes.length} op(s).`);
 *   } else {
 *     new Notice(`Undo partial — see console.`);
 *   }
 */
export class TransactionReplayer {
  constructor(
    private readonly deps: {
      adapter: VaultAdapter;
      log: TransactionLog;
    },
  ) {}

  /**
   * Peek at the transaction that would be undone, without modifying the
   * log. Used by the confirmation modal to show the user what's about to
   * happen.
   */
  async peekLast(): Promise<Transaction | null> {
    const recent = await this.deps.log.recent(1);
    return recent.length === 0 ? null : recent[0];
  }

  async undo(): Promise<UndoResult> {
    // Note: we peek + then removeLast on success rather than removing
    // first. Doing it this way means a crash mid-undo leaves the log
    // intact so the user can retry.
    const tx = await this.peekLast();
    if (tx === null) {
      return { transaction: null, outcomes: [], removedFromLog: false };
    }

    const outcomes: UndoOpOutcome[] = [];
    // Reverse insertion order — last-applied gets undone first.
    const opsInReverse = [...tx.ops].reverse();
    let allOk = true;

    for (const op of opsInReverse) {
      const outcome = await this.applyInverse(op);
      outcomes.push(outcome);
      if (!outcome.ok) {
        allOk = false;
        break; // bail on first failure (see class doc for rationale)
      }
    }

    if (allOk) {
      await this.deps.log.removeLast();
    }

    return {
      transaction: tx,
      outcomes,
      removedFromLog: allOk,
    };
  }

  private async applyInverse(op: AppliedOp): Promise<UndoOpOutcome> {
    try {
      await dispatchInverse(this.deps.adapter, op.inverse);
      return { toolName: op.toolName, path: op.path, inverse: op.inverse, ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolName: op.toolName,
        path: op.path,
        inverse: op.inverse,
        ok: false,
        error: message,
      };
    }
  }
}

/**
 * Dispatch on the inverse-op variant and call the right adapter method.
 * Exported for tests that want to exercise a single inverse type without
 * spinning up the full replayer.
 */
export async function dispatchInverse(adapter: VaultAdapter, inverse: InverseOp): Promise<void> {
  switch (inverse.kind) {
    case 'delete-file':
      // Idempotent best-effort: if the file is already gone (user deleted
      // it manually after Claude created it), treat that as success.
      if (await adapter.exists(inverse.path)) {
        await adapter.delete(inverse.path);
      }
      return;
    case 'write-file':
      // Restore the prior content verbatim. Note: this can overwrite
      // edits the user made since Claude's write — v0.4.0 ships this
      // last-writer-wins behavior intentionally (the confirmation modal
      // surfaces what's about to happen). A `expectedPostHash` field on
      // AppliedOp would let us refuse-on-drift; left as a v0.4.0.1
      // follow-up if undo proves to cost user data.
      await adapter.write(inverse.path, inverse.content);
      return;
    case 'rename-file':
      // v0.4.1 — undo a move/rename. We renameFile() back to the original
      // path. Obsidian's metadata cache will auto-update wikilinks again.
      // If `from` is already gone (user manually moved it back, say),
      // skip silently rather than throwing — same idempotence as
      // delete-file.
      if (!(await adapter.exists(inverse.from))) {
        return;
      }
      await adapter.renameFile(inverse.from, inverse.to);
      return;
    default: {
      // TypeScript exhaustiveness check. Unreachable in well-typed code,
      // but the agent might emit a future InverseOp shape from an older
      // transactions.json after a downgrade — fail loud rather than
      // silently no-op.
      const exhaustive: never = inverse;
      throw new Error(
        `dispatchInverse: unknown inverse op shape ${JSON.stringify(exhaustive)}. ` +
          'Was transactions.json written by a newer plugin version?',
      );
    }
  }
}
