import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';

import { KIND_GLYPHS, formatRelative, pathOf, summarize } from '../activity/format';
import type { ActivityEvent, ActivityEventKind } from '../activity/types';
import type SagittariusPlugin from '../main';

export const ACTIVITY_VIEW_TYPE = 'sagittarius-activity';

/**
 * Phase 6 (v0.8.0) — activity stream panel per
 * [ADR-019](../../docs/2026-05-12-adr-019-phase-6-plan.md) D3.
 *
 * Reverse-chronological feed of every event the plugin records:
 * classifier calls, suggestion lifecycle, writes, undos, index builds,
 * errors. Filter chips collapse the 9-kind taxonomy into 6 categories
 * (errors get their own chip — they're the highest-signal kind for
 * debugging). Clicking an event with a `notePath` / `path` opens that
 * note (saves a trip to the file explorer).
 *
 * Re-render: explicit refresh on every chip click + manual refresh
 * button + `onOpen()`. The plugin's `refreshSuggestionsView()` hook
 * also calls `refresh()` whenever a new event is recorded.
 */
export class ActivityView extends ItemView {
  private listEl!: HTMLElement;
  private headerCountEl!: HTMLElement;
  private activeFilter: FilterId = 'all';

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return ACTIVITY_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'Sagittarius — Activity';
  }

  override getIcon(): string {
    return 'activity';
  }

  override async onOpen(): Promise<void> {
    this.containerEl.empty();
    const root = this.containerEl.createDiv({ cls: 'sagittarius-activity' });
    this.renderHeader(root);
    this.listEl = root.createDiv({ cls: 'sagittarius-activity-list' });
    await this.refresh();
  }

  override onClose(): Promise<void> {
    this.containerEl.empty();
    return Promise.resolve();
  }

  /** Public — invoked from main.ts after a new event is recorded. */
  async refresh(): Promise<void> {
    const log = this.plugin.activityLog;
    if (log === null) {
      this.listEl.empty();
      this.listEl.createEl('p', {
        cls: 'sagittarius-activity-empty',
        text:
          'Activity log is off. Enable it under Settings → Sagittarius → Activity stream.',
      });
      this.headerCountEl.setText('0');
      return;
    }

    const filterKinds = FILTERS[this.activeFilter];
    const listOpts: { limit: number; kinds?: ActivityEventKind[]; sinceMs?: number } = {
      limit: 200,
    };
    if (filterKinds !== null) {
      listOpts.kinds = filterKinds;
    }
    if (this.activeFilter === 'last24h') {
      listOpts.sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    }
    const events = await log.list(listOpts);
    const total = await log.size();
    this.headerCountEl.setText(`${events.length} of ${total}`);

    this.listEl.empty();
    if (events.length === 0) {
      this.listEl.createEl('p', {
        cls: 'sagittarius-activity-empty',
        text:
          total === 0
            ? 'No activity yet. Try organizing your inbox, building the index, or running a chat tool.'
            : 'No events match this filter.',
      });
      return;
    }
    for (const event of events) {
      this.renderRow(event);
    }
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'sagittarius-activity-header' });
    header.createEl('h3', { text: 'Activity' });
    const count = header.createSpan({ cls: 'sagittarius-activity-count' });
    count.setText('0');
    this.headerCountEl = count;

    const actions = header.createDiv({ cls: 'sagittarius-activity-actions' });
    const refreshBtn = actions.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => {
      void this.refresh();
    });
    const clearBtn = actions.createEl('button', { text: 'Clear filtered' });
    clearBtn.addEventListener('click', () => {
      void this.handleClearFiltered();
    });

    const chips = parent.createDiv({ cls: 'sagittarius-activity-chips' });
    for (const id of FILTER_ORDER) {
      const chip = chips.createEl('button', {
        text: FILTER_LABELS[id],
        cls:
          'sagittarius-activity-chip' +
          (this.activeFilter === id ? ' sagittarius-activity-chip-active' : ''),
      });
      chip.addEventListener('click', () => {
        this.activeFilter = id;
        for (const sibling of Array.from(chips.children)) {
          sibling.removeClass('sagittarius-activity-chip-active');
        }
        chip.addClass('sagittarius-activity-chip-active');
        void this.refresh();
      });
    }
  }

  private renderRow(event: ActivityEvent): void {
    const row = this.listEl.createDiv({
      cls: `sagittarius-activity-row sagittarius-activity-row--${event.kind.replace(/\./g, '-')}`,
    });

    const meta = row.createDiv({ cls: 'sagittarius-activity-meta' });
    meta.createSpan({
      cls: 'sagittarius-activity-ts',
      text: formatRelative(event.timestamp, Date.now()),
    });
    meta.createSpan({
      cls: 'sagittarius-activity-kind',
      text: KIND_GLYPHS[event.kind],
    });

    const body = row.createDiv({ cls: 'sagittarius-activity-body' });
    body.setText(summarize(event));

    const notePath = pathOf(event);
    if (notePath !== null) {
      row.addClass('sagittarius-activity-row-clickable');
      row.addEventListener('click', () => {
        void this.plugin.app.workspace.openLinkText(notePath, '', false);
      });
    }
  }

  /**
   * v0.8.2 — drop every event matching the active filter. Mirrors the
   * SuggestionsView's Skip-all but applied to the activity log. When the
   * filter is `all`, clears the entire log. When `last24h`, clears only
   * the last 24h. When kind-scoped (errors, classifier, etc.), clears
   * only that kind.
   */
  private async handleClearFiltered(): Promise<void> {
    const log = this.plugin.activityLog;
    if (log === null) {
      return;
    }
    const filterKinds = FILTERS[this.activeFilter];
    const clearOpts: { kinds?: ActivityEventKind[]; sinceMs?: number } = {};
    if (filterKinds !== null) {
      clearOpts.kinds = filterKinds;
    }
    if (this.activeFilter === 'last24h') {
      clearOpts.sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    }
    const dropped = await log.clearMatching(clearOpts);
    if (dropped === 0) {
      new Notice('Sagittarius: nothing to clear for this filter.');
    } else {
      new Notice(
        `Sagittarius: cleared ${dropped} event(s) (${FILTER_LABELS[this.activeFilter]}).`,
      );
    }
    await this.refresh();
  }
}

// ────────────────────────────────────────────────────────────────────
// Filter taxonomy — collapses the 9 ADR-019 kinds into 6 chip groups.
// ────────────────────────────────────────────────────────────────────

type FilterId =
  | 'all'
  | 'last24h'
  | 'errors'
  | 'classifier'
  | 'suggestions'
  | 'writes'
  | 'index';

const FILTER_ORDER: FilterId[] = [
  'all',
  'last24h',
  'errors',
  'classifier',
  'suggestions',
  'writes',
  'index',
];

const FILTER_LABELS: Record<FilterId, string> = {
  all: 'All',
  last24h: 'Last 24h',
  errors: 'Errors',
  classifier: 'Classifier',
  suggestions: 'Suggestions',
  writes: 'Writes',
  index: 'Index',
};

/** Map filter chip → which event kinds to include. `null` = no kind filter. */
const FILTERS: Record<FilterId, ActivityEventKind[] | null> = {
  all: null,
  last24h: null,
  errors: ['error'],
  classifier: ['classifier.ran'],
  suggestions: [
    'suggestion.enqueued',
    'suggestion.applied',
    'suggestion.rejected',
    'suggestion.skipped',
  ],
  writes: ['write.committed', 'write.undone'],
  index: ['index.built'],
};
