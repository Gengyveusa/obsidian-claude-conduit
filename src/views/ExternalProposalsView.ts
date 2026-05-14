import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';

import type SagittariusPlugin from '../main';
import type { ExternalProposalEntry } from '../writes/ExternalProposalQueue';
import type { Proposal } from '../writes/types';

export const EXTERNAL_PROPOSALS_VIEW_TYPE = 'sagittarius-external-proposals';

/**
 * Phase 6.7 (v1.1.0) — side panel listing pending proposals enqueued
 * by MCP-driven writes per ADR-025 D4 (b). Each row carries the
 * source attribution ("Claude Desktop"), the tool name, the target
 * path, when it arrived, and Approve / Reject buttons that resolve
 * the queue entry's promise.
 *
 * Re-render on:
 *   - `onOpen` — initial paint
 *   - `queue.onChange()` — subscribed for the lifetime of the view
 *   - Approve / Reject click — local re-render (the queue's notify
 *     fires too, but the local refresh is instant)
 *
 * ADR-025 OQ1 is settled in this view by the simplest answer: the
 * Approve button in the side panel resolves the proposal directly,
 * **without** re-opening the in-app diff card. The diff (`proposal.diff`)
 * is rendered inline on the row, so the user already sees what they're
 * approving — bouncing them to a modal would be redundant.
 */
export class ExternalProposalsView extends ItemView {
  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return EXTERNAL_PROPOSALS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Sagittarius — External proposals';
  }

  override getIcon(): string {
    return 'inbox';
  }

  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: 'sagittarius-external-proposals' });
    this.renderHeader(root);
    this.listEl = root.createDiv({ cls: 'sagittarius-external-proposals-list' });

    const queue = this.plugin.externalProposalQueue;
    if (queue !== null) {
      this.unsubscribe = queue.onChange(() => {
        this.refresh();
      });
    }
    this.refresh();
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.containerEl.empty();
    return Promise.resolve();
  }

  /** Public — main.ts re-renders when the queue size changes. */
  refresh(): void {
    const queue = this.plugin.externalProposalQueue;
    if (queue === null) {
      this.listEl.empty();
      this.listEl.createEl('p', {
        cls: 'sagittarius-external-proposals-empty',
        text:
          'MCP write-side is not configured. Enable it under Settings → Sagittarius → MCP write-side.',
      });
      this.headerCountEl.setText('0');
      return;
    }

    const entries = queue.pending();
    this.headerCountEl.setText(String(entries.length));

    this.listEl.empty();
    if (entries.length === 0) {
      this.listEl.createEl('p', {
        cls: 'sagittarius-external-proposals-empty',
        text:
          'No external proposals pending. When an MCP client (Claude Desktop, Claude Code) ' +
          'asks to write to the vault, you\'ll review it here.',
      });
      return;
    }

    for (const entry of entries) {
      this.renderRow(entry);
    }
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'sagittarius-external-proposals-header' });
    header.createEl('h3', { text: 'External proposals' });
    const count = header.createSpan({ cls: 'sagittarius-external-proposals-count' });
    count.setText('0');
    this.headerCountEl = count;
    parent.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Write proposals from MCP clients (Claude Desktop, Claude Code) live here ' +
        'until you approve or reject. The originating tool keeps running in the ' +
        'background — accept here and the file write applies (with full undo support).',
    });
  }

  private renderRow(entry: ExternalProposalEntry): void {
    const row = this.listEl.createDiv({ cls: 'sagittarius-external-proposals-row' });

    // Meta line: source · tool · timestamp
    const meta = row.createDiv({ cls: 'sagittarius-external-proposals-meta' });
    meta.createSpan({
      cls: 'sagittarius-external-proposals-source',
      text: prettifySource(entry.source),
    });
    meta.createSpan({ text: ' · ' });
    meta.createSpan({
      cls: 'sagittarius-external-proposals-tool',
      text: entry.proposal.toolName,
    });
    meta.createSpan({ text: ' · ' });
    meta.createSpan({
      cls: 'sagittarius-external-proposals-ts',
      text: relativeTime(entry.enqueuedAt, Date.now()),
    });

    // Path line.
    const path = primaryPath(entry.proposal);
    if (path !== null) {
      row.createDiv({
        cls: 'sagittarius-external-proposals-path',
        text: path,
      });
    }

    // Diff preview.
    const preview = row.createDiv({ cls: 'sagittarius-external-proposals-diff' });
    preview.createEl('pre', { text: previewDiff(entry.proposal) });

    // Action buttons.
    const actions = row.createDiv({ cls: 'sagittarius-external-proposals-actions' });
    const approveBtn = actions.createEl('button', {
      text: 'Approve',
      cls: 'mod-cta',
    });
    approveBtn.addEventListener('click', () => {
      this.respond(entry, 'accept');
    });
    const rejectBtn = actions.createEl('button', { text: 'Reject' });
    rejectBtn.addEventListener('click', () => {
      this.respond(entry, 'reject');
    });
  }

  private respond(entry: ExternalProposalEntry, action: 'accept' | 'reject'): void {
    const queue = this.plugin.externalProposalQueue;
    if (queue === null) {
      return;
    }
    try {
      if (action === 'accept') {
        queue.respond(entry.id, { kind: 'accept' });
        new Notice(`Sagittarius: approved '${entry.proposal.toolName}'.`);
      } else {
        queue.respond(entry.id, { kind: 'reject', reason: 'user rejected via side panel' });
        new Notice(`Sagittarius: rejected '${entry.proposal.toolName}'.`);
      }
    } catch (err) {
      // Most likely: entry was already responded to (raced against a timeout-
      // and-respond from another path). Notify, not throw.
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: couldn't respond — ${msg}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers — kept local because they're view-presentation only.
// ────────────────────────────────────────────────────────────────────

function prettifySource(source: string): string {
  if (source.startsWith('mcp:')) {
    const name = source.slice(4);
    if (name.length === 0) {
      return 'MCP (anonymous)';
    }
    return `MCP · ${name}`;
  }
  return source;
}

function primaryPath(proposal: Proposal): string | null {
  const obj = proposal.args;
  if (typeof obj === 'object' && obj !== null) {
    if (typeof obj.path === 'string') {
      return obj.path;
    }
    if (typeof obj.to === 'string' && typeof obj.from === 'string') {
      return `${obj.from} → ${obj.to}`;
    }
    if (typeof obj.from === 'string') {
      return obj.from;
    }
  }
  return null;
}

function previewDiff(proposal: Proposal): string {
  const { diff } = proposal;
  switch (diff.kind) {
    case 'create-file':
      return prefixLines(truncate(diff.content, 600), '+ ');
    case 'append-to-file':
      return prefixLines(truncate(diff.appendedContent, 400), '+ ');
    case 'patch-file':
      return `--- before (truncated)\n${truncate(diff.before, 200)}\n--- after (truncated)\n${truncate(diff.after, 400)}`;
    case 'rename-file':
      return `${diff.fromPath} → ${diff.toPath}`;
    case 'binary-file':
      return `binary · ${diff.sizeBytes} bytes`;
    case 'delete-file':
      return prefixLines(truncate(diff.content, 600), '- ');
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max)}\n… (${s.length - max} more chars)`;
}

function prefixLines(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function relativeTime(then: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 60) {
    return `${diff}s ago`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  return `${Math.floor(diff / 3600)}h ago`;
}
