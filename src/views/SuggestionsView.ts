import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';

import type SagittariusPlugin from '../main';
import type { Suggestion, RouteSuggestion } from '../organization/types';

export const SUGGESTIONS_VIEW_TYPE = 'sagittarius-suggestions';

/**
 * Phase 5 (v0.6.0) — proactive suggestions panel per [ADR-017](../../docs/2026-05-11-adr-017-phase-5-plan.md) D2.
 *
 * Renders the rows in the plugin's `SuggestionQueue` with Apply / Skip /
 * Defer buttons. Apply routes through the existing Phase 4 write tools
 * (so the diff card still gates every actual file change). Skip and
 * Defer mutate the queue directly.
 *
 * Re-render policy: explicit refresh on every user action + on
 * `onOpen()`. The plugin's `refreshSuggestionsView()` hook also triggers
 * a re-render when the watcher enqueues new suggestions.
 */
export class SuggestionsView extends ItemView {
  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return SUGGESTIONS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Sagittarius — Suggestions';
  }

  override getIcon(): string {
    return 'lightbulb';
  }

  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: 'sagittarius-suggestions' });
    this.renderHeader(root);
    this.listEl = root.createDiv({ cls: 'sagittarius-suggestions-list' });
    await this.refresh();
  }

  override onClose(): Promise<void> {
    this.containerEl.empty();
    return Promise.resolve();
  }

  /** Public — invoked from main.ts after watcher.classifyNote() enqueues. */
  async refresh(): Promise<void> {
    const queue = this.plugin.suggestionQueue;
    if (queue === null) {
      this.listEl.empty();
      this.listEl.createEl('p', {
        cls: 'sagittarius-suggestions-empty',
        text:
          'Organization engine is off. Enable it under Settings → Sagittarius → Organization (Phase 5).',
      });
      this.headerCountEl.setText('0');
      return;
    }

    const minConfidence = this.plugin.settings.organizationMinConfidence;
    const visible = await queue.list({
      includeDeferred: true,
      minConfidence,
    });
    const total = await queue.size();

    this.headerCountEl.setText(`${visible.length} of ${total}`);

    this.listEl.empty();
    if (visible.length === 0) {
      this.listEl.createEl('p', {
        cls: 'sagittarius-suggestions-empty',
        text:
          total === 0
            ? "No suggestions yet. Create or modify a note in a watched folder, or run “Sagittarius: organize inbox now.”"
            : `${total} below-threshold suggestion(s) hidden. Lower the minimum confidence in settings to see them.`,
      });
      return;
    }

    for (const s of visible) {
      this.renderRow(s);
    }
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'sagittarius-suggestions-header' });
    header.createEl('h3', { text: 'Suggestions' });
    const count = header.createSpan({ cls: 'sagittarius-suggestions-count' });
    count.setText('0');
    this.headerCountEl = count;

    const actions = header.createDiv({ cls: 'sagittarius-suggestions-actions' });
    const sweepBtn = actions.createEl('button', { text: 'Organize inbox now' });
    sweepBtn.addEventListener('click', () => {
      void this.plugin.runOrganizationSweep();
    });
    const refreshBtn = actions.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => {
      void this.refresh();
    });
    const applyAllBtn = actions.createEl('button', {
      text: 'Apply all',
      cls: 'mod-cta',
    });
    applyAllBtn.addEventListener('click', () => {
      void this.handleApplyAll();
    });
    const skipAllBtn = actions.createEl('button', { text: 'Skip all' });
    skipAllBtn.addEventListener('click', () => {
      void this.handleSkipAll();
    });
  }

  private renderRow(s: Suggestion): void {
    const row = this.listEl.createDiv({
      cls:
        'sagittarius-suggestion-row' +
        (s.deferred === true ? ' sagittarius-suggestion-deferred' : ''),
    });

    const head = row.createDiv({ cls: 'sagittarius-suggestion-head' });
    head.createSpan({
      cls: 'sagittarius-suggestion-kind',
      text: kindLabel(s.kind),
    });
    head.createSpan({
      cls: 'sagittarius-suggestion-confidence',
      text: `(${Math.round(s.confidence * 100)}%)`,
    });

    const body = row.createDiv({ cls: 'sagittarius-suggestion-body' });
    body.createEl('code', { text: s.notePath });
    if (s.kind === 'route') {
      body.appendText('  →  ');
      body.createEl('code', { text: s.proposedFolder });
    } else if (s.kind === 'moc-add') {
      body.appendText('  +→  ');
      body.createEl('code', { text: s.mocPath });
    } else if (s.kind === 'archive-stale') {
      body.appendText(`  →  `);
      body.createEl('code', { text: s.proposedFolder });
      body.appendText(`  (${s.staleDays}d)`);
    } else if (s.kind === 'broken-link-fix') {
      body.appendText(`  ✗  `);
      body.createEl('code', { text: s.linkText });
    }

    const reason = row.createDiv({ cls: 'sagittarius-suggestion-reason' });
    reason.setText(s.reason);

    const buttons = row.createDiv({ cls: 'sagittarius-suggestion-buttons' });
    const applyBtn = buttons.createEl('button', {
      text: 'Apply',
      cls: 'mod-cta',
    });
    const skipBtn = buttons.createEl('button', { text: 'Skip' });
    const deferBtn = buttons.createEl('button', { text: 'Defer' });

    if (s.deferred === true) {
      deferBtn.disabled = true;
      deferBtn.setText('Deferred');
    }

    applyBtn.addEventListener('click', () => {
      void this.handleApply(s);
    });
    skipBtn.addEventListener('click', () => {
      void this.handleSkip(s);
    });
    deferBtn.addEventListener('click', () => {
      void this.handleDefer(s);
    });
  }

  private async handleApply(s: Suggestion): Promise<void> {
    if (s.kind === 'moc-add') {
      // v0.6.x — apply routes through `link_notes` (gated by the Phase 4
      // diff card). main.ts owns the actual tool invocation; the panel
      // just translates the outcome to a Notice and refreshes itself.
      const result = await this.plugin.applyMocAddSuggestion(s);
      if (result === 'applied') {
        new Notice(`Sagittarius: linked ${s.notePath} from ${s.mocPath}`);
      } else if (result === 'rejected') {
        new Notice('Sagittarius: rejected in diff card — suggestion removed.');
      } else {
        new Notice('Sagittarius: apply did not complete — see console.');
      }
      await this.refresh();
      return;
    }
    if (s.kind === 'route') {
      const result = await this.plugin.applyRouteSuggestion(s);
      if (result === 'applied') {
        new Notice(`Sagittarius: moved ${s.notePath} → ${s.proposedFolder}`);
      } else if (result === 'rejected') {
        new Notice('Sagittarius: rejected in diff card — suggestion removed.');
      } else {
        new Notice(`Sagittarius: apply did not complete — see console.`);
      }
      await this.refresh();
      return;
    }
    if (s.kind === 'broken-link-fix') {
      const result = await this.plugin.applyBrokenLinkFixSuggestion(s);
      if (result === 'applied') {
        new Notice(`Sagittarius: removed ${s.linkText} from ${s.notePath}`);
      } else if (result === 'rejected') {
        new Notice('Sagittarius: rejected in diff card — suggestion removed.');
      } else {
        new Notice('Sagittarius: apply did not complete — see console.');
      }
      await this.refresh();
      return;
    }
    if (s.kind === 'archive-stale') {
      const result = await this.plugin.applyArchiveStaleSuggestion(s);
      if (result === 'applied') {
        new Notice(`Sagittarius: archived ${s.notePath} → ${s.proposedFolder}`);
      } else if (result === 'rejected') {
        new Notice('Sagittarius: rejected in diff card — suggestion removed.');
      } else {
        new Notice('Sagittarius: apply did not complete — see console.');
      }
      await this.refresh();
    }
  }

  private async handleSkip(s: Suggestion): Promise<void> {
    const queue = this.plugin.suggestionQueue;
    if (queue === null) {
      return;
    }
    await queue.remove(s.id);
    await this.plugin.activityLog?.record({
      kind: 'suggestion.skipped',
      suggestionId: s.id,
      notePath: s.notePath,
      bulk: false,
    });
    await this.refresh();
  }

  private async handleDefer(s: Suggestion): Promise<void> {
    const queue = this.plugin.suggestionQueue;
    if (queue === null) {
      return;
    }
    await queue.defer(s.id);
    await this.refresh();
  }

  /**
   * Bulk apply every visible suggestion. Each routes through its own
   * Phase 4 diff card (ADR-016 D2 invariant — every write is gated). The
   * user clicks Confirm / Reject per suggestion; we tally the outcomes
   * and surface a single summary Notice at the end.
   *
   * @example User has 3 route suggestions and clicks "Apply all":
   *   - Diff card 1 → Confirm → applied
   *   - Diff card 2 → Reject  → rejected
   *   - Diff card 3 → Confirm → applied
   *   Notice: "Applied 2, rejected 1, errors 0."
   */
  private async handleApplyAll(): Promise<void> {
    const queue = this.plugin.suggestionQueue;
    if (queue === null) {
      return;
    }
    const minConfidence = this.plugin.settings.organizationMinConfidence;
    const snapshot = await queue.list({ includeDeferred: true, minConfidence });
    if (snapshot.length === 0) {
      new Notice('Sagittarius: no visible suggestions to apply.');
      return;
    }
    let applied = 0;
    let rejected = 0;
    let errored = 0;
    for (const s of snapshot) {
      let result: 'applied' | 'rejected' | 'error';
      if (s.kind === 'moc-add') {
        result = await this.plugin.applyMocAddSuggestion(s);
      } else if (s.kind === 'route') {
        result = await this.plugin.applyRouteSuggestion(s);
      } else if (s.kind === 'broken-link-fix') {
        result = await this.plugin.applyBrokenLinkFixSuggestion(s);
      } else {
        result = await this.plugin.applyArchiveStaleSuggestion(s);
      }
      if (result === 'applied') {
        applied += 1;
      } else if (result === 'rejected') {
        rejected += 1;
      } else {
        errored += 1;
      }
    }
    new Notice(
      `Sagittarius: applied ${applied}, rejected ${rejected}, errors ${errored}.`,
    );
    await this.refresh();
  }

  /**
   * Bulk skip every visible suggestion. Drops them from the queue
   * without invoking any write tool. Below-threshold suggestions are
   * untouched (the panel's filter is the source of "visible").
   */
  private async handleSkipAll(): Promise<void> {
    const queue = this.plugin.suggestionQueue;
    if (queue === null) {
      return;
    }
    const minConfidence = this.plugin.settings.organizationMinConfidence;
    const snapshot = await queue.list({ includeDeferred: true, minConfidence });
    if (snapshot.length === 0) {
      return;
    }
    for (const s of snapshot) {
      await queue.remove(s.id);
      await this.plugin.activityLog?.record({
        kind: 'suggestion.skipped',
        suggestionId: s.id,
        notePath: s.notePath,
        bulk: true,
      });
    }
    new Notice(`Sagittarius: skipped ${snapshot.length} suggestion(s).`);
    await this.refresh();
  }
}

/** Compute the destination path for an applied route suggestion. Exported for tests. */
export function destinationPathFor(s: RouteSuggestion): string {
  const basename = s.notePath.split('/').pop() ?? s.notePath;
  return s.proposedFolder.length > 0 ? `${s.proposedFolder}/${basename}` : basename;
}

/** Short label shown in the suggestion-row header. Exported for tests. */
export function kindLabel(kind: Suggestion['kind']): string {
  switch (kind) {
    case 'route':
      return '↪ Move';
    case 'moc-add':
      return '+ Add to MOC';
    case 'broken-link-fix':
      return '✗ Broken link';
    case 'archive-stale':
      return '📦 Archive stale';
  }
}
