import { type App, Modal } from 'obsidian';

import type { SnapshotMeta } from '../timetravel/types';

/**
 * Phase 16 (v1.10.0) — modal that asks the operator which snapshot to
 * query against per ADR-037 D6. Surfaces the snapshots from plugin
 * settings + the "Current" sentinel for exiting time-travel.
 *
 * Returns the chosen snapshot via `onPick` callback (or `null` for
 * "Current" / Cancel). The caller (ChatView) flips the chat mode based
 * on the result.
 */
export class SnapshotPickerModal extends Modal {
  constructor(
    app: App,
    private readonly snapshots: ReadonlyArray<SnapshotMeta>,
    private readonly onPick: (picked: SnapshotMeta | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sagittarius-snapshot-picker');

    contentEl.createEl('h3', { text: 'Pick a snapshot to query against' });

    if (this.snapshots.length === 0) {
      const empty = contentEl.createDiv({ cls: 'sagittarius-snapshot-empty' });
      empty.createEl('p', {
        text:
          'No snapshots yet. Run `Sagittarius: Snapshot vault for time-travel` ' +
          'with time-travel enabled in Settings to capture one. Snapshots are ' +
          'keyed to git commits — `git checkout` an older commit first if you ' +
          'want a historical state, then run the command.',
      });
      const closeRow = contentEl.createDiv({ cls: 'sagittarius-snapshot-buttons' });
      const closeBtn = closeRow.createEl('button', { text: 'Close', cls: 'mod-cta' });
      closeBtn.addEventListener('click', () => {
        this.onPick(null);
        this.close();
      });
      return;
    }

    const list = contentEl.createDiv({ cls: 'sagittarius-snapshot-list' });

    // "Current" sentinel — picking this exits time-travel back to whichever
    // mode the operator had before opening the picker.
    const currentRow = list.createDiv({ cls: 'sagittarius-snapshot-row' });
    const currentBtn = currentRow.createEl('button', {
      cls: 'sagittarius-snapshot-pick',
      text: 'Current — today’s vault (exit time-travel)',
    });
    currentBtn.addEventListener('click', () => {
      this.onPick(null);
      this.close();
    });

    // Snapshots, newest first.
    const sorted = [...this.snapshots].sort((a, b) => b.createdAt - a.createdAt);
    for (const snap of sorted) {
      const row = list.createDiv({ cls: 'sagittarius-snapshot-row' });
      const btn = row.createEl('button', { cls: 'sagittarius-snapshot-pick' });
      const labelParts: string[] = [snap.date, `\`${snap.commitSha.slice(0, 7)}\``];
      if (snap.tag !== null) {
        labelParts.push(`tag: ${snap.tag}`);
      }
      if (snap.pinned) {
        labelParts.push('pinned');
      }
      labelParts.push(`${snap.chunkCount} chunks`);
      btn.setText(labelParts.join('  ·  '));
      btn.addEventListener('click', () => {
        this.onPick(snap);
        this.close();
      });
    }

    const buttons = contentEl.createDiv({ cls: 'sagittarius-snapshot-buttons' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.onPick(null);
      this.close();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
