import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from 'obsidian';

import type { TurnResult } from '../agent/ConduitAgent';
import type SagittariusPlugin from '../main';

export const CHAT_VIEW_TYPE = 'sagittarius-chat';

/**
 * Sagittarius's side panel — Obsidian ItemView with a chat surface.
 * v0.1 (Phase 3e-3b): chat mode only with the 4 vault-API tools.
 * vault-qa mode is gated behind retrieval which lands in 3e-3c.
 *
 * History is in-memory only — closing the panel discards the
 * conversation. Persistence to vault happens via ConversationLogger
 * on every turn, so the chat IS preserved (just not the in-panel
 * scrollback).
 */
export class ChatView extends ItemView {
  private history: MessageParam[] = [];
  private mode: 'chat' | 'vault-qa' = 'chat';
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private busy = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Sagittarius';
  }

  override getIcon(): string {
    return 'message-square';
  }

  override onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: 'sagittarius-chat' });

    this.renderHeader(root);
    this.messagesEl = root.createDiv({ cls: 'sagittarius-messages' });
    this.renderEmptyState();
    this.renderInputRow(root);
    this.statusEl = root.createDiv({ cls: 'sagittarius-status' });
    this.refreshStatus();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.containerEl.empty();
    return Promise.resolve();
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'sagittarius-header' });
    header.createEl('h3', { text: 'Sagittarius' });

    const modeRow = header.createDiv({ cls: 'sagittarius-mode-row' });
    modeRow.createEl('label', { text: 'Mode: ' });
    const select = modeRow.createEl('select');
    select.createEl('option', { value: 'chat', text: 'Chat' });
    select.createEl('option', { value: 'vault-qa', text: 'Vault QA' });
    select.value = this.mode;
    select.addEventListener('change', () => {
      if (select.value === 'chat' || select.value === 'vault-qa') {
        this.mode = select.value;
      }
    });
  }

  private renderEmptyState(): void {
    const empty = this.messagesEl.createDiv({ cls: 'sagittarius-empty' });
    empty.createEl('p', {
      text:
        this.plugin.settings.apiKey.length > 0
          ? 'Ready. Ask Sagittarius about your vault.'
          : 'Set your Anthropic API key in Settings → Sagittarius before chatting.',
    });
    if (!this.plugin.settings.apiKey) {
      const example = empty.createEl('p');
      example.createEl('em', { text: 'Example: "summarize the file 50-FortressFlow/Pipeline_State.md".' });
    }
  }

  private renderInputRow(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'sagittarius-input-row' });
    this.inputEl = row.createEl('textarea', {
      cls: 'sagittarius-input',
      placeholder: 'Type a message…  ⌘+Enter to send',
    });
    this.sendButton = row.createEl('button', { text: 'Send', cls: 'sagittarius-send' });

    this.sendButton.addEventListener('click', () => {
      void this.sendCurrent();
    });
    this.inputEl.addEventListener('keydown', (event) => {
      const isSubmit =
        (event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.shiftKey;
      if (isSubmit) {
        event.preventDefault();
        void this.sendCurrent();
      }
    });
  }

  private async sendCurrent(): Promise<void> {
    if (this.busy) {
      return;
    }
    const text = this.inputEl.value.trim();
    if (text.length === 0) {
      return;
    }

    const agent = await this.plugin.getAgentBundle();
    if (!agent) {
      new Notice('Sagittarius: set your Anthropic API key in Settings → Sagittarius first.');
      return;
    }

    this.busy = true;
    this.sendButton.disabled = true;
    this.inputEl.disabled = true;

    // Render the user message immediately.
    this.clearEmptyState();
    this.appendUserMessage(text);
    this.inputEl.value = '';

    const placeholder = this.appendAssistantPlaceholder();

    try {
      const result = await agent.agent.chat(text, this.history, this.mode);
      this.history.push({ role: 'user', content: text });
      this.history.push({ role: 'assistant', content: result.finalText });
      await this.fillAssistantMessage(placeholder, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      placeholder.empty();
      placeholder.createEl('p', { text: `Error: ${msg}`, cls: 'sagittarius-error' });
    } finally {
      this.busy = false;
      this.sendButton.disabled = false;
      this.inputEl.disabled = false;
      this.inputEl.focus();
      this.refreshStatus();
    }
  }

  private clearEmptyState(): void {
    const empty = this.messagesEl.querySelector('.sagittarius-empty');
    empty?.remove();
  }

  private appendUserMessage(text: string): void {
    const bubble = this.messagesEl.createDiv({
      cls: 'sagittarius-message sagittarius-message-user',
    });
    const role = bubble.createDiv({ cls: 'sagittarius-role' });
    role.setText('You');
    bubble.createDiv({ cls: 'sagittarius-body', text });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private appendAssistantPlaceholder(): HTMLElement {
    const bubble = this.messagesEl.createDiv({
      cls: 'sagittarius-message sagittarius-message-assistant',
    });
    const role = bubble.createDiv({ cls: 'sagittarius-role' });
    role.setText('Sagittarius');
    bubble.createDiv({ cls: 'sagittarius-body', text: '…thinking' });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return bubble;
  }

  private async fillAssistantMessage(bubble: HTMLElement, result: TurnResult): Promise<void> {
    bubble.empty();
    const role = bubble.createDiv({ cls: 'sagittarius-role' });
    role.setText('Sagittarius');
    const body = bubble.createDiv({ cls: 'sagittarius-body' });
    await MarkdownRenderer.render(this.app, result.finalText, body, '', this);

    if (result.citations.length > 0) {
      const details = bubble.createEl('details', { cls: 'sagittarius-citations' });
      const summary = details.createEl('summary');
      summary.setText(`▾ Why? (${result.citations.length} notes consulted)`);
      const list = details.createEl('ul');
      for (const cite of result.citations) {
        const li = list.createEl('li');
        li.createEl('strong', { text: `[[${cite.path}]]` });
        li.appendText(` (score ${cite.score.toFixed(2)}): ${truncate(cite.snippet, 200)}`);
      }
    }

    const meta = bubble.createDiv({ cls: 'sagittarius-meta' });
    meta.setText(
      `Tokens in/out: ${result.tokensIn} / ${result.tokensOut} · ` +
        `Steps: ${result.steps} · Cost: $${result.costUsd.toFixed(4)} · ${result.durationMs} ms`,
    );

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private refreshStatus(): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.empty();
    const apiKeyOk = this.plugin.settings.apiKey.length > 0;
    const turn = this.history.length / 2;
    const indexing = this.plugin.isIndexing() ? ' · indexing…' : '';
    this.statusEl.setText(
      apiKeyOk
        ? `Model: ${this.plugin.settings.defaultModel} · Turn ${Math.floor(turn)}${indexing}`
        : 'API key not set — open Settings → Sagittarius.',
    );
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}…`;
}
