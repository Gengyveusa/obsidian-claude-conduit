import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from 'obsidian';

import type { TurnResult } from '../agent/ConduitAgent';
import { formatMemoryFooter } from '../memory/MemoryCascade';
import type SagittariusPlugin from '../main';
import type { Decision, Proposal, ProposalDiff } from '../writes/types';

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

  /**
   * Phase 12 (v1.5.0) — read-only snapshot of the in-memory chat
   * history per ADR-033. `Sagittarius: Journal this session` reads
   * this to summarize what the operator was working on. Returns a
   * defensive copy so external callers can't mutate the live array.
   */
  recentHistory(): ReadonlyArray<MessageParam> {
    return [...this.history];
  }

  private mode: 'chat' | 'vault-qa' = 'chat';
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  /** Phase 8 (v1.3.2) — draft-mode banner above the messages area. */
  private draftBannerEl?: HTMLElement;
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
    this.draftBannerEl = root.createDiv({ cls: 'sagittarius-draft-banner' });
    this.refreshDraftBanner();
    this.messagesEl = root.createDiv({ cls: 'sagittarius-messages' });
    this.renderEmptyState();
    this.renderInputRow(root);
    this.statusEl = root.createDiv({ cls: 'sagittarius-status' });
    this.refreshStatus();

    // Register as the active approval surface so Phase 4 write tools
    // route their proposals through this view's diff card.
    this.plugin.approvalGate.set((proposal) => this.requestApproval(proposal));

    // Phase 8 (v1.3.2) — refresh draft banner on active-leaf changes
    // so opening a draft makes the indicator appear instantly.
    this.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => {
        this.refreshDraftBanner();
      }),
    );

    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.plugin.approvalGate.set(null);
    this.containerEl.empty();
    return Promise.resolve();
  }

  /**
   * Phase 8 (v1.3.2) — return the active-file path when it's under
   * `_drafts/`, else `null`. Used by both the per-send draft-mode
   * scoping (passed to `chat()`) and the banner refresh.
   */
  private activeDraftPath(): string | null {
    const file = this.plugin.app.workspace.getActiveFile();
    if (file === null) {
      return null;
    }
    return file.path.startsWith('_drafts/') ? file.path : null;
  }

  /**
   * Phase 8 (v1.3.2) — render the draft-mode banner above the
   * messages area. Shows the active draft path when one is open;
   * hidden otherwise. Per ADR-026 D5(d) the banner is informational
   * — to "exit" draft mode, open a non-draft file.
   */
  private refreshDraftBanner(): void {
    if (this.draftBannerEl === undefined) {
      return;
    }
    const draftPath = this.activeDraftPath();
    this.draftBannerEl.empty();
    if (draftPath === null) {
      this.draftBannerEl.style.display = 'none';
      return;
    }
    this.draftBannerEl.style.display = '';
    this.draftBannerEl.createSpan({ text: 'Refining draft: ' });
    this.draftBannerEl.createEl('code', { text: draftPath });
    this.draftBannerEl.createSpan({
      cls: 'sagittarius-draft-banner-hint',
      text: ' — chat scopes edits here. Open another file to exit.',
    });
  }

  /**
   * Render a diff card for the proposal and return a Promise that resolves
   * with the user's decision. Called by `CallbackApprovalGate` per ADR-016
   * D2 — inline + per-tool + always-required approval.
   */
  requestApproval(proposal: Proposal): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      this.clearEmptyState();
      const card = this.messagesEl.createDiv({ cls: 'sagittarius-diff-card' });

      const header = card.createDiv({ cls: 'sagittarius-diff-header' });
      header.createEl('strong', { text: proposal.toolName });
      header.createSpan({
        cls: 'sagittarius-diff-path',
        text: ` · ${headerPathFor(proposal.diff)}`,
      });

      const body = card.createDiv({ cls: 'sagittarius-diff-body' });
      renderProposalDiff(body, proposal.diff);

      const buttons = card.createDiv({ cls: 'sagittarius-diff-buttons' });
      const acceptBtn = buttons.createEl('button', {
        text: 'Accept',
        cls: 'sagittarius-diff-accept',
      });
      const rejectBtn = buttons.createEl('button', {
        text: 'Reject',
        cls: 'sagittarius-diff-reject',
      });

      const finalize = (decoration: string, lockedClass: string): void => {
        acceptBtn.disabled = true;
        rejectBtn.disabled = true;
        card.addClass(lockedClass);
        const note = card.createDiv({ cls: 'sagittarius-diff-resolution' });
        note.setText(decoration);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      };

      acceptBtn.addEventListener('click', () => {
        finalize('✓ Accepted', 'sagittarius-diff-accepted');
        resolve({ kind: 'accept' });
      });
      rejectBtn.addEventListener('click', () => {
        finalize('✗ Rejected', 'sagittarius-diff-rejected');
        resolve({ kind: 'reject', reason: 'user rejected via chat panel' });
      });

      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'sagittarius-header' });
    header.createEl('h3', { text: 'Sagittarius' });

    const modeRow = header.createDiv({ cls: 'sagittarius-mode-row' });
    modeRow.createEl('label', { text: 'Mode: ' });
    const select = modeRow.createEl('select');
    select.createEl('option', { value: 'chat', text: 'Chat' });
    const vaultQaOption = select.createEl('option', {
      value: 'vault-qa',
      text: 'Vault QA',
    });
    // vault-qa requires retrieval to be initialized (HF token set);
    // gracefully disable when not, like v0.1.1.
    if (!this.plugin.hasRetrieval()) {
      vaultQaOption.disabled = true;
      vaultQaOption.text = 'Vault QA (set HuggingFace token)';
    }
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
      // Phase 8 (v1.3.2) — draft refine mode per ADR-026 D5(d)+D6(c).
      // When the active file is a draft, scope the agent to refining
      // it via patch_note. Detection is per-send so swapping files
      // mid-conversation reflects on the next message.
      const draftPath = this.activeDraftPath();
      const result = await agent.agent.chat(
        text,
        this.history,
        this.mode,
        undefined,
        draftPath,
      );
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

    // Phase 9 (v1.3.0) — chat-response memory footer per ADR-029 D7.
    // Reads from the provider's `lastResult` populated during the
    // just-finished turn. Silent when memory is disabled (the
    // status-bar pill already signals "memory: off").
    const memoryResult = this.plugin.memoryProvider?.lastResult ?? null;
    if (memoryResult !== null) {
      const memoryMeta = bubble.createDiv({ cls: 'sagittarius-meta sagittarius-meta-memory' });
      memoryMeta.setText(formatMemoryFooter(memoryResult));
    }

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

/**
 * Header-line path for the diff card. Most variants have a single `path`
 * but `rename-file` carries `fromPath` + `toPath` instead.
 */
function headerPathFor(diff: ProposalDiff): string {
  if (diff.kind === 'rename-file') {
    return `${diff.fromPath} → ${diff.toPath}`;
  }
  return diff.path;
}

/** Human-readable byte size for the binary-file diff card. */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Render a `ProposalDiff` into the diff card body. v0.3.0 supports the two
 * variants used by `create_note` and `append_to_note`; later phases extend.
 *
 * Output style: pre-formatted block with `+`/` ` prefixes per line, mimicking
 * `git diff` so the visual is familiar. We keep this dumb on purpose — once
 * `patch_note` arrives in v0.3.x and we have real ops, this will get a
 * proper diff renderer.
 */
function renderProposalDiff(parent: HTMLElement, diff: ProposalDiff): void {
  if (diff.kind === 'rename-file') {
    // v0.4.1 — no content diff; just show old → new.
    const row = parent.createDiv({ cls: 'sagittarius-diff-rename' });
    row.createEl('code', { text: diff.fromPath, cls: 'sagittarius-diff-line-del' });
    row.createSpan({ text: '  →  ' });
    row.createEl('code', { text: diff.toPath, cls: 'sagittarius-diff-line-add' });
    return;
  }
  if (diff.kind === 'binary-file') {
    // v0.5.0 — no content diff; show path + size.
    const row = parent.createDiv({ cls: 'sagittarius-diff-binary' });
    row.createEl('code', { text: `+ ${diff.path}`, cls: 'sagittarius-diff-line-add' });
    row.createSpan({ text: `  (${formatSize(diff.sizeBytes)})`, cls: 'sagittarius-diff-binary-size' });
    return;
  }
  if (diff.kind === 'delete-file') {
    // v1.0.7 — render every prior-content line as a deletion. Users
    // need to see exactly what's vanishing before they approve.
    const pre = parent.createEl('pre', { cls: 'sagittarius-diff-pre' });
    for (const line of diff.content.split('\n')) {
      pre.createDiv({ cls: 'sagittarius-diff-line-del', text: `- ${line}` });
    }
    return;
  }
  const pre = parent.createEl('pre', { cls: 'sagittarius-diff-pre' });
  if (diff.kind === 'create-file') {
    for (const line of diff.content.split('\n')) {
      pre.createDiv({ cls: 'sagittarius-diff-line-add', text: `+ ${line}` });
    }
    return;
  }
  if (diff.kind === 'append-to-file') {
    // append: show last lines of existing tail as context, then new lines as +
    if (diff.existingTail.length > 0) {
      for (const line of diff.existingTail.split('\n')) {
        pre.createDiv({ cls: 'sagittarius-diff-line-ctx', text: `  ${line}` });
      }
    }
    for (const line of diff.appendedContent.split('\n')) {
      pre.createDiv({ cls: 'sagittarius-diff-line-add', text: `+ ${line}` });
    }
    return;
  }
  // patch-file: render a per-line diff between before and after. Naive LCS
  // is good enough for v0.3.x — the tool already validated the patch
  // before getting here, so what we render is the literal new-vs-old view.
  renderLineDiff(pre, diff.before, diff.after);
}

/**
 * Render a naive line-by-line diff: every line either unchanged (ctx), deleted (-),
 * or added (+). Uses a Myers-style longest-common-subsequence walk. Good enough
 * for the v0.3.x patch_note view; can be swapped for a smarter renderer later.
 */
function renderLineDiff(parent: HTMLElement, beforeText: string, afterText: string): void {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  const lcsTable = computeLcsTable(before, after);
  const ops = walkLcs(before, after, lcsTable);
  for (const op of ops) {
    const cls =
      op.kind === 'add'
        ? 'sagittarius-diff-line-add'
        : op.kind === 'del'
          ? 'sagittarius-diff-line-del'
          : 'sagittarius-diff-line-ctx';
    const marker = op.kind === 'add' ? '+ ' : op.kind === 'del' ? '- ' : '  ';
    parent.createDiv({ cls, text: marker + op.line });
  }
}

interface DiffOp {
  kind: 'add' | 'del' | 'ctx';
  line: string;
}

/** O(n*m) LCS DP table. n,m small (file lines), so this is fine. */
function computeLcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function walkLcs(a: string[], b: string[], dp: number[][]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.unshift({ kind: 'ctx', line: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.unshift({ kind: 'del', line: a[i - 1] });
      i--;
    } else {
      ops.unshift({ kind: 'add', line: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    ops.unshift({ kind: 'del', line: a[i - 1] });
    i--;
  }
  while (j > 0) {
    ops.unshift({ kind: 'add', line: b[j - 1] });
    j--;
  }
  return ops;
}
