import { type App, Modal, Notice } from 'obsidian';

import type { ActivityLog } from '../activity/ActivityLog';
import type { TransactionReplayer, UndoResult } from '../writes/TransactionReplayer';
import type { Transaction } from '../writes/types';

/**
 * Confirmation modal for the v0.4.0 `Sagittarius: Undo last write
 * transaction` command. Shows a preview of the inverse ops that will run
 * — especially important because `write-file` inverses can clobber edits
 * the user made after Claude's write.
 *
 * Flow:
 *   1. Caller calls `replayer.peekLast()` and constructs this modal
 *      with the preview transaction. If `null`, surfaces "Nothing to undo"
 *      as a Notice and never opens.
 *   2. Modal renders the transaction summary + Confirm/Cancel buttons.
 *   3. On Confirm: invokes `replayer.undo()`, displays a Notice with
 *      the outcome (full success / partial failure / no-op), then closes.
 *   4. On Cancel: closes silently.
 */
export class UndoConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly preview: Transaction,
    private readonly replayer: TransactionReplayer,
    private readonly activityLog: ActivityLog | null = null,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sagittarius-undo-modal');

    contentEl.createEl('h3', { text: 'Undo last write transaction?' });

    const meta = contentEl.createDiv({ cls: 'sagittarius-quick-meta' });
    const when = new Date(this.preview.timestamp * 1000).toLocaleString();
    meta.setText(
      `${this.preview.ops.length} op(s), recorded at ${when}` +
        (this.preview.sessionId !== undefined ? ` (session ${this.preview.sessionId})` : ''),
    );

    const list = contentEl.createEl('ul', { cls: 'sagittarius-undo-list' });
    // Show in REPLAY order (reverse of apply) so the user sees what'll happen first.
    const opsInReplayOrder = [...this.preview.ops].reverse();
    for (const op of opsInReplayOrder) {
      const li = list.createEl('li');
      li.createEl('strong', { text: describeInverse(op.inverse) });
      li.appendText(`  ←  ${op.toolName} on `);
      li.createEl('code', { text: op.path });
    }

    const warn = contentEl.createDiv({ cls: 'sagittarius-undo-warn' });
    warn.setText(
      'Heads up: `write-file` inverses restore the prior content verbatim. ' +
        "Any edits you've made to those files since will be overwritten.",
    );

    const row = contentEl.createDiv({ cls: 'sagittarius-quick-buttons' });
    const confirmBtn = row.createEl('button', { text: 'Confirm undo', cls: 'mod-warning' });
    const cancelBtn = row.createEl('button', { text: 'Cancel' });

    confirmBtn.addEventListener('click', () => {
      void this.runUndo();
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async runUndo(): Promise<void> {
    let result: UndoResult;
    try {
      result = await this.replayer.undo();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: undo crashed — ${msg}`);
      this.close();
      return;
    }

    if (result.transaction === null) {
      new Notice('Sagittarius: nothing to undo (log was empty).');
    } else if (result.removedFromLog) {
      new Notice(
        `Sagittarius: undid ${result.outcomes.length} op(s) and removed the transaction from the log.`,
      );
      if (this.activityLog !== null) {
        await this.activityLog.record({
          kind: 'write.undone',
          transactionId: result.transaction.id,
        });
      }
    } else {
      const failedOutcome = result.outcomes.find((o) => !o.ok);
      const successCount = result.outcomes.filter((o) => o.ok).length;
      new Notice(
        `Sagittarius: undo partial — ${successCount} of ${result.outcomes.length} ops applied. ` +
          `Failed on ${failedOutcome?.path ?? '?'}: ${failedOutcome?.error ?? 'unknown'}. ` +
          'Transaction left in log; fix the file and retry, or examine transactions.json.',
      );
    }

    this.close();
  }
}

/**
 * Human-readable description of an inverse op for the modal preview.
 * Kept narrow on purpose — adding fields here would make the modal noisy.
 */
function describeInverse(inv: Transaction['ops'][number]['inverse']): string {
  switch (inv.kind) {
    case 'delete-file':
      return `Delete ${inv.path}`;
    case 'write-file':
      return `Restore ${inv.path} to ${inv.content.length} bytes`;
    case 'rename-file':
      return `Rename ${inv.from} → ${inv.to}`;
  }
}
