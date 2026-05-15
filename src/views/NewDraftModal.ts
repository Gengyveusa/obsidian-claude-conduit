import { type App, Modal } from 'obsidian';

/**
 * Phase 8 (v1.1.1) — topic-input modal for `Sagittarius: New draft`
 * per ADR-026 D5. Two inputs: topic (required, free text) and
 * destination folder (optional, defaults from settings).
 *
 * The modal doesn't run drafting itself — it collects inputs and
 * resolves with a `{ topic, destinationFolder }` value. The caller
 * (main.ts) handles the engine + write proposal.
 *
 * Returns `null` if the user cancels (Esc / Cancel / closes the modal
 * without submitting).
 */
export interface NewDraftModalInputs {
  topic: string;
  /** Empty string = use settings default. */
  destinationFolder: string;
}

export class NewDraftModal extends Modal {
  private resolve: ((value: NewDraftModalInputs | null) => void) | null = null;
  private submitted = false;
  private readonly defaultDestination: string;
  /**
   * Phase 9.x (v1.4.0) — pre-fill the topic input. Used by
   * `Sagittarius: Suggest drafts` so clicking a suggestion opens
   * the modal with the suggested topic already typed.
   */
  private readonly initialTopic: string;

  constructor(app: App, defaultDestination: string, initialTopic = '') {
    super(app);
    this.defaultDestination = defaultDestination;
    this.initialTopic = initialTopic;
  }

  /** Open the modal and return a promise that resolves on submit/cancel. */
  prompt(): Promise<NewDraftModalInputs | null> {
    return new Promise<NewDraftModalInputs | null>((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sagittarius-new-draft-modal');

    contentEl.createEl('h3', { text: 'Sagittarius — new draft' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Sagittarius will draft a cited markdown note based on your vault. ' +
        'The draft lands in the `_drafts/` quarantine folder; promote it via ' +
        '`Sagittarius: Promote draft` when ready.',
    });

    const topicLabel = contentEl.createEl('label', { text: 'Topic' });
    topicLabel.style.display = 'block';
    topicLabel.style.marginTop = '12px';
    const topicInput = contentEl.createEl('textarea', {
      cls: 'sagittarius-new-draft-topic',
      placeholder: 'e.g. Q3 roadmap synthesis from leadership-sync notes',
    });
    topicInput.rows = 3;
    topicInput.style.width = '100%';
    if (this.initialTopic.length > 0) {
      topicInput.value = this.initialTopic;
    }
    topicInput.focus();
    // Place cursor at the end of any pre-filled text so operator
    // can immediately edit instead of overwriting.
    if (this.initialTopic.length > 0) {
      topicInput.setSelectionRange(this.initialTopic.length, this.initialTopic.length);
    }

    const folderLabel = contentEl.createEl('label', {
      text: `Destination folder (default ${this.defaultDestination || 'vault root'})`,
    });
    folderLabel.style.display = 'block';
    folderLabel.style.marginTop = '12px';
    const folderInput = contentEl.createEl('input', {
      type: 'text',
      cls: 'sagittarius-new-draft-folder',
      placeholder: this.defaultDestination || '10-Inbox',
    });
    folderInput.style.width = '100%';

    const buttonRow = contentEl.createDiv({ cls: 'sagittarius-new-draft-buttons' });
    buttonRow.style.marginTop = '16px';
    buttonRow.style.display = 'flex';
    buttonRow.style.gap = '8px';
    buttonRow.style.justifyContent = 'flex-end';
    const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });
    const submitButton = buttonRow.createEl('button', { text: 'Draft', cls: 'mod-cta' });

    const submit = (): void => {
      const topic = topicInput.value.trim();
      if (topic.length === 0) {
        topicInput.focus();
        return;
      }
      this.submitted = true;
      this.resolve?.({
        topic,
        destinationFolder: folderInput.value.trim(),
      });
      this.resolve = null;
      this.close();
    };

    submitButton.addEventListener('click', submit);
    cancelButton.addEventListener('click', () => this.close());
    topicInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.submitted && this.resolve !== null) {
      this.resolve(null);
      this.resolve = null;
    }
  }
}
