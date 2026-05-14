import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';

import type { DraftRecord } from '../drafts/DraftStore';
import { promotedPathFor } from '../drafts/paths';
import type SagittariusPlugin from '../main';

export const DRAFTS_VIEW_TYPE = 'sagittarius-drafts';

/**
 * Phase 8 (v1.2.0) — side panel listing every file under `_drafts/`
 * per ADR-026 D5 (a). Each row carries the topic, the drafting model,
 * the time generated, the count of cited chunks, and three buttons:
 *
 *   - **Open**   → `workspace.openLinkText` opens the draft in the
 *                  editor for direct refinement (markdown editor is
 *                  the iteration surface until ChatView Draft mode
 *                  lands in v1.2.x per ADR-026 D6).
 *   - **Promote** → routes through the existing `move_note` flow so
 *                   the diff card per ADR-016 D2 shows the rename.
 *   - **Discard** → routes through `delete_note` (also diff-carded).
 *
 * Refreshes:
 *   - `onOpen` initial paint
 *   - Vault `create` / `modify` / `delete` events (Obsidian
 *     `app.vault.on('...')`) — subscribed for the view's lifetime
 *
 * No external dependency — uses the plugin's `DraftStore` instance,
 * which is in turn backed by the same `VaultAdapter` every other
 * subsystem uses.
 */
export class DraftsView extends ItemView {
  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private vaultUnsubscribes: Array<() => void> = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return DRAFTS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Sagittarius — Drafts';
  }

  override getIcon(): string {
    return 'file-pen';
  }

  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: 'sagittarius-drafts' });
    this.renderHeader(root);
    this.listEl = root.createDiv({ cls: 'sagittarius-drafts-list' });

    // Re-render on vault changes — the panel reflects whatever's on
    // disk so promotion / discard / external edits show up instantly.
    // Each event needs its own `on` call because Obsidian's vault
    // event API has per-event-name overloads (no union accepted).
    const handler = (): void => {
      void this.refresh();
    };
    const refs = [
      this.plugin.app.vault.on('create', handler),
      this.plugin.app.vault.on('modify', handler),
      this.plugin.app.vault.on('delete', handler),
      this.plugin.app.vault.on('rename', handler),
    ];
    for (const ref of refs) {
      this.vaultUnsubscribes.push(() => this.plugin.app.vault.offref(ref));
    }

    await this.refresh();
  }

  override onClose(): Promise<void> {
    for (const unsub of this.vaultUnsubscribes) {
      unsub();
    }
    this.vaultUnsubscribes = [];
    this.containerEl.empty();
    return Promise.resolve();
  }

  /** Public — re-enumerate drafts and re-render. */
  async refresh(): Promise<void> {
    const store = this.plugin.draftStore;
    if (store === null) {
      this.listEl.empty();
      this.listEl.createEl('p', {
        cls: 'sagittarius-drafts-empty',
        text: 'Drafts subsystem not ready. Reload the plugin.',
      });
      this.headerCountEl.setText('0');
      return;
    }

    const drafts = await store.list();
    this.headerCountEl.setText(String(drafts.length));

    this.listEl.empty();
    if (drafts.length === 0) {
      this.listEl.createEl('p', {
        cls: 'sagittarius-drafts-empty',
        text:
          'No drafts yet. Run "Sagittarius: New draft" (Cmd+P) to create one — ' +
          'it will land in the `_drafts/` quarantine folder until you promote it.',
      });
      return;
    }
    for (const draft of drafts) {
      this.renderRow(draft);
    }
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'sagittarius-drafts-header' });
    header.createEl('h3', { text: 'Drafts' });
    const count = header.createSpan({ cls: 'sagittarius-drafts-count' });
    count.setText('0');
    this.headerCountEl = count;
    parent.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Cited drafts produced by `Sagittarius: New draft` live here until you ' +
        'promote or discard them. Promote moves the file out of `_drafts/`; ' +
        'discard deletes it via the regular diff card.',
    });
  }

  private renderRow(draft: DraftRecord): void {
    const row = this.listEl.createDiv({ cls: 'sagittarius-drafts-row' });

    // Title — topic if present, else first heading, else path-derived.
    const titleText =
      draft.topic ?? draft.firstHeading ?? slugFromPath(draft.path);
    row.createEl('div', { cls: 'sagittarius-drafts-title', text: titleText });

    // Meta line.
    const meta = row.createDiv({ cls: 'sagittarius-drafts-meta' });
    meta.createSpan({ text: draft.path });
    if (draft.draftingModel !== null) {
      meta.createSpan({ text: ' · ' });
      meta.createSpan({ text: draft.draftingModel });
    }
    if (draft.generatedAt !== null) {
      meta.createSpan({ text: ' · ' });
      meta.createSpan({
        text: relativeTime(draft.generatedAt, Math.floor(Date.now() / 1000)),
      });
    }
    meta.createSpan({ text: ' · ' });
    meta.createSpan({
      text:
        draft.citedChunksCount === 0
          ? 'no citations'
          : `${draft.citedChunksCount} citation${draft.citedChunksCount === 1 ? '' : 's'}`,
    });

    // Action buttons.
    const actions = row.createDiv({ cls: 'sagittarius-drafts-actions' });
    const openBtn = actions.createEl('button', { text: 'Open' });
    openBtn.addEventListener('click', () => {
      void this.plugin.app.workspace.openLinkText(draft.path, '', false);
    });
    const promoteBtn = actions.createEl('button', { text: 'Promote', cls: 'mod-cta' });
    promoteBtn.addEventListener('click', () => {
      void this.promote(draft);
    });
    const discardBtn = actions.createEl('button', { text: 'Discard' });
    discardBtn.addEventListener('click', () => {
      void this.discard(draft);
    });
  }

  private async promote(draft: DraftRecord): Promise<void> {
    const bundle = await this.plugin.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key in Settings → Sagittarius first.');
      return;
    }
    let canonical: string;
    try {
      canonical = promotedPathFor(draft.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: ${msg}`);
      return;
    }
    await this.plugin.activateChatView();
    try {
      await bundle.deps.tools.execute('move_note', {
        from: draft.path,
        to: canonical,
      });
      new Notice(
        `Sagittarius: promotion proposal sent to the chat panel — review and accept.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: promotion failed — ${msg}`);
    }
  }

  private async discard(draft: DraftRecord): Promise<void> {
    const bundle = await this.plugin.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key in Settings → Sagittarius first.');
      return;
    }
    await this.plugin.activateChatView();
    try {
      await bundle.deps.tools.execute('delete_note', { path: draft.path });
      new Notice(
        `Sagittarius: discard proposal sent to the chat panel — review and accept.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: discard failed — ${msg}`);
    }
  }
}

function slugFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const file = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return file.replace(/\.md$/, '');
}

function relativeTime(thenSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - thenSec);
  if (diff < 60) {
    return `${diff}s ago`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  if (diff < 86_400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }
  return `${Math.floor(diff / 86_400)}d ago`;
}
