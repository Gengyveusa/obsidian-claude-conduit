import { type App, MarkdownRenderer, Modal, Notice } from 'obsidian';

import type SagittariusPlugin from '../main';

/**
 * Cmd+P modal for single-shot questions per spec §5.4. Doesn't
 * persist history; each invocation is independent. Enter (without
 * Shift) submits; Esc closes.
 */
export class QuickQuestionModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sagittarius-quick-modal');

    contentEl.createEl('h3', { text: 'Sagittarius — quick question' });

    const textarea = contentEl.createEl('textarea', {
      cls: 'sagittarius-quick-input',
      placeholder: 'Ask…  ⏎ to send, Esc to cancel',
    });
    textarea.rows = 3;
    textarea.focus();

    const buttonRow = contentEl.createDiv({ cls: 'sagittarius-quick-buttons' });
    const askButton = buttonRow.createEl('button', { text: 'Ask', cls: 'mod-cta' });
    const cancelButton = buttonRow.createEl('button', { text: 'Cancel' });

    const ask = (): void => {
      const text = textarea.value.trim();
      if (text.length === 0) {
        return;
      }
      void this.runQuery(text);
    };

    askButton.addEventListener('click', ask);
    cancelButton.addEventListener('click', () => this.close());
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        ask();
      }
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async runQuery(text: string): Promise<void> {
    const agent = await this.plugin.getAgentBundle();
    if (!agent) {
      new Notice('Sagittarius: set your Anthropic API key in Settings → Sagittarius first.');
      return;
    }

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Sagittarius — quick question' });
    contentEl.createDiv({ cls: 'sagittarius-quick-prompt' }).setText(`> ${text}`);
    const responseEl = contentEl.createDiv({ cls: 'sagittarius-quick-response' });
    responseEl.setText('…thinking');

    try {
      const result = await agent.agent.chat(text, [], 'chat');
      responseEl.empty();
      await MarkdownRenderer.render(this.app, result.finalText, responseEl, '', this.plugin);

      const meta = contentEl.createDiv({ cls: 'sagittarius-quick-meta' });
      meta.setText(
        `${result.tokensIn} in / ${result.tokensOut} out · $${result.costUsd.toFixed(4)} · ${result.durationMs} ms`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      responseEl.setText(`Error: ${msg}`);
    }

    const closeButton = contentEl.createEl('button', { text: 'Close', cls: 'mod-cta' });
    closeButton.addEventListener('click', () => this.close());
  }
}
