import { type App, Modal } from 'obsidian';

/**
 * Phase 7 v1.0.7 — keeper-picker modal for the
 * `duplicate-candidate` curator apply path per ADR-024 follow-up.
 *
 * The curator finds two notes that an LLM judge confirmed are
 * duplicates. The user must decide which one to keep and which one to
 * merge-in then delete — that choice can't be automated safely. This
 * modal renders the two paths side-by-side with a short preview snippet
 * for each, then surfaces three buttons:
 *
 *   - **Keep A (merge B in, then delete B)** → resolves with `'keep-a'`
 *   - **Keep B (merge A in, then delete A)** → resolves with `'keep-b'`
 *   - **Cancel** → resolves with `'cancel'` (the suggestion stays in queue)
 *
 * The caller awaits the returned promise. Calling `close()` resolves
 * with `'cancel'` (the user pressed Escape or clicked away).
 *
 * @example
 *   const choice = await openDuplicateMergeModal(app, {
 *     pathA, previewA, pathB, previewB,
 *   });
 *   if (choice === 'cancel') return;
 *   const [keep, discard] = choice === 'keep-a' ? [pathA, pathB] : [pathB, pathA];
 *   // ... patch_note keep with discard's content, then delete_note discard
 */
export type DuplicateMergeChoice = 'keep-a' | 'keep-b' | 'cancel';

export interface DuplicateMergeModalInput {
  pathA: string;
  previewA: string;
  pathB: string;
  previewB: string;
  /** Similarity score from the curator finding, for context (0..1). */
  similarity: number;
}

/** Open the modal and resolve with the user's choice. */
export function openDuplicateMergeModal(
  app: App,
  input: DuplicateMergeModalInput,
): Promise<DuplicateMergeChoice> {
  return new Promise((resolve) => {
    const modal = new DuplicateMergeModal(app, input, resolve);
    modal.open();
  });
}

class DuplicateMergeModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly input: DuplicateMergeModalInput,
    private readonly onChoice: (c: DuplicateMergeChoice) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sagittarius-duplicate-merge-modal');

    contentEl.createEl('h3', { text: 'Merge duplicate candidates?' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        `These two notes look like duplicates (cosine ≈ ${this.input.similarity.toFixed(2)}). ` +
        'Pick which one to keep; the other will be merged into it under a `## Merged from ` ' +
        'header, then deleted. Both writes route through the diff card so you can sanity-check ' +
        'before either commits.',
    });

    this.renderPreview(contentEl, 'A', this.input.pathA, this.input.previewA);
    this.renderPreview(contentEl, 'B', this.input.pathB, this.input.previewB);

    const row = contentEl.createDiv({ cls: 'sagittarius-quick-buttons' });
    const keepA = row.createEl('button', { text: 'Keep A (delete B)' });
    const keepB = row.createEl('button', { text: 'Keep B (delete A)' });
    const cancel = row.createEl('button', { text: 'Cancel' });

    keepA.addEventListener('click', () => {
      this.resolve('keep-a');
    });
    keepB.addEventListener('click', () => {
      this.resolve('keep-b');
    });
    cancel.addEventListener('click', () => {
      this.resolve('cancel');
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    // Cancel-on-dismiss: Escape / click-outside should not leave the
    // caller hanging on the promise.
    if (!this.resolved) {
      this.resolved = true;
      this.onChoice('cancel');
    }
  }

  private resolve(choice: DuplicateMergeChoice): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.onChoice(choice);
    this.close();
  }

  private renderPreview(
    parent: HTMLElement,
    label: 'A' | 'B',
    path: string,
    preview: string,
  ): void {
    const block = parent.createDiv({ cls: 'sagittarius-duplicate-merge-block' });
    const header = block.createDiv({ cls: 'sagittarius-duplicate-merge-header' });
    header.createEl('strong', { text: label });
    header.createSpan({ text: '  ' });
    header.createEl('code', { text: path });
    const pre = block.createEl('pre', { cls: 'sagittarius-duplicate-merge-preview' });
    pre.setText(preview.length === 0 ? '(empty file)' : preview);
  }
}
