import Anthropic from '@anthropic-ai/sdk';
import { Notice, Plugin, type TAbstractFile, requestUrl } from 'obsidian';

import { ConduitAgent } from './agent/ConduitAgent';
import { ToolRegistry } from './agent/ToolRegistry';
import { makeAddFrontmatterTool } from './agent/tools/add_frontmatter';
import { makeAppendToNoteTool } from './agent/tools/append_to_note';
import { makeCreateNoteTool } from './agent/tools/create_note';
import { makeFileAssetTool } from './agent/tools/file_asset';
import { makeLinkNotesTool } from './agent/tools/link_notes';
import { makeMoveNoteTool } from './agent/tools/move_note';
import { makePatchNoteTool } from './agent/tools/patch_note';
import { makeRenameNoteTool } from './agent/tools/rename_note';
import { makeRewriteSectionTool } from './agent/tools/rewrite_section';
import { makeGetBacklinksTool } from './agent/tools/get_backlinks';
import { makeGetGraphNeighborhoodTool } from './agent/tools/get_graph_neighborhood';
import { makeListFolderTool } from './agent/tools/list_folder';
import { makeReadNoteTool } from './agent/tools/read_note';
import { makeSearchVaultTool } from './agent/tools/search_vault';
import { BudgetTracker } from './budget/BudgetTracker';
import { PluginDataBudgetPersistence } from './budget/PluginDataBudgetPersistence';
import type { MessagesAPI } from './agent/ConduitAgent';
import {
  formatDiagnosticsReport,
  formatDiagnosticsSummary,
  gatherDiagnostics,
} from './diag/OrganizationDiagnostics';
import { SystemCheck, formatReport, formatSummary } from './diag/SystemCheck';
import { IndexCoordinator } from './indexing/IndexCoordinator';
import { IndexPersistence } from './indexing/IndexPersistence';
import { ConversationLogger } from './log/ConversationLogger';
import { MetadataCacheImpl } from './obsidian/MetadataCacheImpl';
import { loadSystemPromptParts } from './obsidian/SystemPromptLoader';
import { VaultAdapterImpl } from './obsidian/VaultAdapterImpl';
import { EmbedClient } from './retrieval/EmbedClient';
import { makeHfInferenceFactory } from './retrieval/HfInferenceFactory';
import { makeObsidianRequestUrlNativeFetch } from './retrieval/obsidianRequestUrl';
import { openSqliteEngine } from './retrieval/openEngine';
import { RetrievalLayer } from './retrieval/RetrievalLayer';
import type { SqliteEngine } from './retrieval/SqliteEngine';
import { JsonActivityLog, type ActivityLog } from './activity/ActivityLog';
import { SagittariusSettingTab } from './settings/SagittariusSettingTab';
import { DEFAULT_SETTINGS, type SagittariusSettings } from './settings/types';
import { MocAddClassifier } from './organization/MocAddClassifier';
import { MocDiscovery } from './organization/MocDiscovery';
import { OrganizationClassifier } from './organization/OrganizationClassifier';
import {
  OrganizationWatcher,
  type VaultEventEmitter,
} from './organization/OrganizationWatcher';
import { JsonSuggestionQueue, type SuggestionQueue } from './organization/SuggestionQueue';
import type { MocAddSuggestion, RouteSuggestion } from './organization/types';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { QuickQuestionModal } from './views/QuickQuestionModal';
import { ActivityView, ACTIVITY_VIEW_TYPE } from './views/ActivityView';
import { SuggestionsView, SUGGESTIONS_VIEW_TYPE, destinationPathFor } from './views/SuggestionsView';
import { UndoConfirmModal } from './views/UndoConfirmModal';
import { CallbackApprovalGate } from './writes/CallbackApprovalGate';
import { JsonTransactionLog } from './writes/TransactionLog';
import { TransactionReplayer } from './writes/TransactionReplayer';
import { WriteToolContext } from './writes/WriteToolContext';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';
const CONSTITUTION_PATH = 'THAD_MAN.md';
const HANGAR_VOICE_PATH = '21-Agents/concierge.md';
const INDEX_DB_PATH = '.obsidian/plugins/obsidian-claude-conduit/index.sqlite';
const TX_LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/transactions.json';
const SUGGESTIONS_PATH = '.obsidian/plugins/obsidian-claude-conduit/suggestions.json';
const ACTIVITY_LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/activity.json';

interface AgentBundle {
  agent: ConduitAgent;
  /** The deps that were passed to the agent. Phase 5 reuses them. */
  deps: ConstructorParameters<typeof ConduitAgent>[0];
}

/**
 * Sagittarius plugin entry point — v0.2.
 *
 * v0.2 brings retrieval back online via the HuggingFace Inference API
 * per ADR-013. When `huggingfaceApiKey` is set in settings, the plugin
 * instantiates EmbedClient + RetrievalLayer + IndexCoordinator and
 * registers `search_vault`. When empty, gracefully degrades to v0.1.1
 * behavior (chat-mode + 4 vault-API tools, no `search_vault`).
 *
 * v0.2 default `indexingMode` is `'manual'` (was `'auto'` in the
 * pre-deferral plan) — indexing now costs network calls; user
 * triggers via `Cmd+P → Build Index` once.
 */
export default class SagittariusPlugin extends Plugin {
  settings: SagittariusSettings = DEFAULT_SETTINGS;
  /**
   * Phase 4 (v0.3.0+) approval surface. `ChatView` registers its
   * `requestApproval` method on open and clears it on close. When no chat
   * view is open, the gate auto-rejects so write tools surface an
   * actionable error to the LLM. See ADR-016 D2.
   */
  readonly approvalGate = new CallbackApprovalGate();
  /**
   * Phase 5 organization-engine state. Lazily constructed when
   * `organizationEnabled` flips on. Null when the engine is off so the
   * SuggestionsView can render an empty-state with a helpful nudge.
   */
  suggestionQueue: SuggestionQueue | null = null;
  /**
   * Phase 6 (v0.8.0) activity stream. Constructed in `onload` (always),
   * consumed by every subsystem that wants to emit. Exposed so the
   * SuggestionsView can record `suggestion.skipped` events directly.
   */
  activityLog: ActivityLog | null = null;
  private organizationWatcher: OrganizationWatcher | null = null;
  private organizationSweepHandle: number | null = null;
  private organizationStatusBarEl: HTMLElement | null = null;
  private agentBundle: AgentBundle | null = null;
  private engine?: SqliteEngine;
  private embedClient?: EmbedClient;
  private indexCoordinator?: IndexCoordinator;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SagittariusSettingTab(this.app, this));

    // Phase 6 (v0.8.0): activity stream — constructed early so every
    // subsystem that wires it in (TransactionLog, OrganizationWatcher,
    // apply/undo/index paths) can pass it through. Persistent JSON log
    // capped at 1000 entries per ADR-019 D4. Disabled = null = every
    // `this.activityLog?.record(...)` site no-ops.
    if (this.settings.activityLogEnabled) {
      this.activityLog = new JsonActivityLog({
        adapter: new VaultAdapterImpl(this.app),
        path: ACTIVITY_LOG_PATH,
      });
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(
      SUGGESTIONS_VIEW_TYPE,
      (leaf) => new SuggestionsView(leaf, this),
    );
    this.registerView(ACTIVITY_VIEW_TYPE, (leaf) => new ActivityView(leaf, this));

    this.addRibbonIcon(RIBBON_ICON, PLUGIN_NAME, () => {
      void this.activateChatView();
    });

    this.addCommand({
      id: 'open-chat-panel',
      name: 'Open chat panel',
      callback: () => {
        void this.activateChatView();
      },
    });

    this.addCommand({
      id: 'quick-question',
      name: 'Quick question',
      callback: () => new QuickQuestionModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'build-index',
      name: 'Build retrieval index (incremental)',
      callback: () => {
        void this.runBuild({ rebuild: false });
      },
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild retrieval index from scratch',
      callback: () => {
        void this.runBuild({ rebuild: true });
      },
    });

    this.addCommand({
      id: 'undo-last-write',
      name: 'Undo last write transaction',
      callback: () => {
        void this.runUndoLastWrite();
      },
    });

    this.addCommand({
      id: 'open-suggestions',
      name: 'Open suggestions panel',
      callback: () => {
        void this.activateSuggestionsView();
      },
    });

    this.addCommand({
      id: 'open-activity',
      name: 'Open activity stream',
      callback: () => {
        void this.activateActivityView();
      },
    });

    this.addCommand({
      id: 'organize-inbox-now',
      name: 'Organize inbox now',
      callback: () => {
        void this.runOrganizationSweep();
      },
    });

    this.addCommand({
      id: 'system-check',
      name: 'System check',
      callback: () => {
        void this.runSystemCheck();
      },
    });

    this.addCommand({
      id: 'run-diagnostics',
      name: 'Run diagnostics',
      callback: () => {
        void this.runOrganizationDiagnostics();
      },
    });

    this.organizationStatusBarEl = this.addStatusBarItem();
    this.organizationStatusBarEl.addClass('sagittarius-status-bar');
    this.organizationStatusBarEl.style.cursor = 'pointer';
    this.organizationStatusBarEl.addEventListener('click', () => {
      void this.activateSuggestionsView();
    });
    this.organizationStatusBarEl.setAttribute(
      'aria-label',
      'Sagittarius suggestions — click to open panel',
    );
    this.organizationStatusBarEl.style.display = 'none';

    try {
      await this.initializeIndexing();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sagittarius] indexing init FAILED: ${msg}`);
      new Notice(`Sagittarius: indexing init failed — ${msg}. Check the developer console.`);
      return;
    }

    console.warn(
      `[sagittarius] ${PLUGIN_NAME} v${this.manifest.version} loaded. ` +
        `Retrieval: ${this.settings.huggingfaceApiKey.length > 0 ? 'enabled (HF Inference API)' : 'disabled (no HF token set)'}.`,
    );

    if (this.settings.indexingMode === 'auto' && this.embedClient) {
      // Background — never block plugin onload.
      setTimeout(() => {
        void this.autoIndexInBackground();
      }, 0);
    }

    // Phase 5: wire the organization engine if the user opted in. Lives
    // outside the initializeIndexing try/catch because a failure here
    // shouldn't block the rest of the plugin.
    this.refreshOrganizationEngine();
  }

  override onunload(): void {
    if (this.organizationSweepHandle !== null) {
      clearInterval(this.organizationSweepHandle);
      this.organizationSweepHandle = null;
    }
    this.organizationWatcher?.stop();
    this.organizationWatcher = null;
    this.suggestionQueue = null;
    this.agentBundle = null;
    this.engine?.close();
    delete this.engine;
    delete this.embedClient;
    delete this.indexCoordinator;
    console.warn(`[sagittarius] ${PLUGIN_NAME} unloaded.`);
  }

  /** True if a build is currently in flight. ChatView polls this for status. */
  isIndexing(): boolean {
    return this.indexCoordinator?.isBuilding() ?? false;
  }

  /** True if HF token is set and retrieval has been initialized. */
  hasRetrieval(): boolean {
    return this.embedClient !== undefined && this.indexCoordinator !== undefined;
  }

  /**
   * Get (or build) the agent bundle. Returns null if no API key is set.
   * @example const bundle = await this.plugin.getAgentBundle();
   */
  async getAgentBundle(): Promise<AgentBundle | null> {
    if (this.settings.apiKey.length === 0) {
      return null;
    }
    if (!this.agentBundle) {
      this.agentBundle = await this.buildAgent();
    }
    return this.agentBundle;
  }

  /** Reset the cached agent so the next chat picks up changed settings. */
  invalidateAgent(): void {
    this.agentBundle = null;
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) {
        new Notice('Sagittarius: no workspace leaf available to open the chat panel.');
        return;
      }
      leaf = rightLeaf;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const persisted = (await this.loadData()) as Record<string, unknown> | null;
    if (!persisted) {
      this.settings = { ...DEFAULT_SETTINGS };
      return;
    }
    const rest: Record<string, unknown> = { ...persisted };
    delete rest['__budget'];
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(rest as Partial<SagittariusSettings>),
    };
  }

  async saveSettings(): Promise<void> {
    const existing = ((await this.loadData()) as Record<string, unknown> | null) ?? {};
    await this.saveData({ ...existing, ...this.settings });
    this.invalidateAgent();
  }

  /** Run a build via the coordinator and surface result via Notice. */
  private async runBuild(opts: { rebuild: boolean }): Promise<void> {
    if (!this.indexCoordinator) {
      new Notice(
        'Sagittarius: indexing requires a HuggingFace API key. ' +
          'Set one in Settings → Sagittarius → Embeddings.',
      );
      return;
    }
    new Notice(`Sagittarius: ${opts.rebuild ? 'rebuilding' : 'indexing'}…`);
    try {
      const result = await this.indexCoordinator.ensureBuilt(opts);
      const seconds = (result.durationMs / 1000).toFixed(1);
      new Notice(
        `Sagittarius: indexed ${result.notesProcessed} notes (${result.chunksAdded} chunks, ` +
          `${result.chunksSkipped} skipped) in ${seconds}s. ` +
          (result.errors.length > 0 ? `${result.errors.length} errors — see console.` : ''),
      );
      if (result.errors.length > 0) {
        for (const e of result.errors) {
          console.warn(`[sagittarius] index error on ${e.path}: ${e.error}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sagittarius] index build FAILED: ${msg}`);
      new Notice(`Sagittarius: index build failed — ${msg}.`);
    }
  }

  /**
   * Run live health checks against every external surface (Anthropic, HF,
   * vault, engine, retrieval). Surfaces a summary Notice + detailed
   * console.warn line. Built to make v0.2.x-class production-only bugs
   * surface in seconds.
   */
  /**
   * v0.4.0 undo command. Lazy-constructs the txLog + replayer so the
   * command works even before the agent has been built (e.g. user
   * hasn't opened chat yet but wants to roll back yesterday's writes).
   */
  private async runUndoLastWrite(): Promise<void> {
    const adapter = new VaultAdapterImpl(this.app);
    const txLog = new JsonTransactionLog({
      adapter,
      path: TX_LOG_PATH,
      ...(this.activityLog !== null && { activityLog: this.activityLog }),
    });
    const replayer = new TransactionReplayer({ adapter, log: txLog });

    const preview = await replayer.peekLast();
    if (preview === null) {
      new Notice('Sagittarius: nothing to undo (transaction log is empty).');
      return;
    }

    new UndoConfirmModal(this.app, preview, replayer, this.activityLog).open();
  }

  // ─── Phase 5 organization engine ──────────────────────────────────

  /**
   * Open the suggestions side panel (creates a leaf if missing).
   */
  async activateSuggestionsView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SUGGESTIONS_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice('Sagittarius: could not open suggestions panel.');
      return;
    }
    await leaf.setViewState({ type: SUGGESTIONS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Open the activity stream side panel (creates a leaf if missing). */
  async activateActivityView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(ACTIVITY_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice('Sagittarius: could not open activity panel.');
      return;
    }
    await leaf.setViewState({ type: ACTIVITY_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Run a manual sweep across watched folders. Notice-only — the
   * SuggestionsView re-renders independently when the user looks at it.
   */
  async runOrganizationSweep(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.organizationWatcher === null) {
      if (opts.silent !== true) {
        new Notice('Sagittarius: organization engine is off. Enable in settings.');
      }
      return;
    }
    if (opts.silent !== true) {
      new Notice('Sagittarius: organizing inbox…');
    }
    const summary = await this.organizationWatcher.sweep();
    const shouldToast = opts.silent !== true || summary.classified > 0;
    if (shouldToast) {
      new Notice(
        `Sagittarius: ${summary.classified} new, ${summary.skipped} skipped, ${summary.errors} error(s).`,
      );
    }
    await this.refreshSuggestionsView();
  }

  /**
   * Apply a `route` suggestion by invoking the registered `move_note`
   * tool (which still gates through the Phase 4 diff card). On accept,
   * removes the suggestion from the queue. On reject, also removes (the
   * user explicitly said no in the diff card). On error, leaves in queue.
   */
  async applyRouteSuggestion(s: RouteSuggestion): Promise<'applied' | 'rejected' | 'error'> {
    if (this.suggestionQueue === null) {
      new Notice('Sagittarius: organization engine is off.');
      return 'error';
    }
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key first.');
      return 'error';
    }
    const toPath = destinationPathFor(s);
    try {
      const result = (await bundle.deps.tools.execute('move_note', {
        fromPath: s.notePath,
        toPath,
      })) as { status: string; error?: string; reason?: string };
      if (result.status === 'applied') {
        await this.suggestionQueue.remove(s.id);
        await this.activityLog?.record({
          kind: 'suggestion.applied',
          suggestionId: s.id,
          suggestionKind: 'route',
          notePath: s.notePath,
          writeToolName: 'move_note',
        });
        return 'applied';
      }
      if (result.status === 'rejected') {
        await this.suggestionQueue.remove(s.id);
        await this.activityLog?.record({
          kind: 'suggestion.rejected',
          suggestionId: s.id,
          notePath: s.notePath,
        });
        return 'rejected';
      }
      // error / conflict
      console.warn(`[sagittarius] apply route failed: ${result.error ?? result.reason ?? ''}`);
      await this.activityLog?.record({
        kind: 'error',
        source: 'apply-route',
        message: result.error ?? result.reason ?? 'unknown',
      });
      return 'error';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sagittarius] apply route threw: ${msg}`);
      await this.activityLog?.record({
        kind: 'error',
        source: 'apply-route',
        message: msg,
      });
      return 'error';
    }
  }

  /**
   * v0.6.x — apply a moc-add suggestion by reading the MOC's current
   * state, then invoking the registered `link_notes` tool (Phase 4
   * diff card still gates the actual write). On accept, removes the
   * suggestion from the queue. On reject, also removes. On error/
   * conflict, leaves in queue so the user can retry.
   */
  async applyMocAddSuggestion(
    s: MocAddSuggestion,
  ): Promise<'applied' | 'rejected' | 'error'> {
    if (this.suggestionQueue === null) {
      new Notice('Sagittarius: organization engine is off.');
      return 'error';
    }
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key first.');
      return 'error';
    }
    try {
      // link_notes requires expectedMtime + expectedHash to detect
      // concurrent edits per ADR-016 D4. Easiest source of both: ask
      // the read_note tool, which already returns these fields.
      const readResult = (await bundle.deps.tools.execute('read_note', {
        path: s.mocPath,
      })) as { mtime: number; hash: string } | null;
      if (readResult === null) {
        new Notice(`Sagittarius: MOC not found at ${s.mocPath}.`);
        return 'error';
      }

      const linkArgs: Record<string, unknown> = {
        fromPath: s.mocPath,
        toPath: s.notePath,
        expectedMtime: readResult.mtime,
        expectedHash: readResult.hash,
      };
      if (s.mocAnchor !== undefined) {
        linkArgs.anchorInFrom = s.mocAnchor;
      }

      const result = (await bundle.deps.tools.execute('link_notes', linkArgs)) as {
        status: string;
        error?: string;
        reason?: string;
      };
      if (result.status === 'applied') {
        await this.suggestionQueue.remove(s.id);
        await this.activityLog?.record({
          kind: 'suggestion.applied',
          suggestionId: s.id,
          suggestionKind: 'moc-add',
          notePath: s.notePath,
          writeToolName: 'link_notes',
        });
        return 'applied';
      }
      if (result.status === 'rejected') {
        await this.suggestionQueue.remove(s.id);
        await this.activityLog?.record({
          kind: 'suggestion.rejected',
          suggestionId: s.id,
          notePath: s.notePath,
        });
        return 'rejected';
      }
      console.warn(`[sagittarius] apply moc-add failed: ${result.error ?? result.reason ?? ''}`);
      await this.activityLog?.record({
        kind: 'error',
        source: 'apply-moc-add',
        message: result.error ?? result.reason ?? 'unknown',
      });
      return 'error';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sagittarius] apply moc-add threw: ${msg}`);
      await this.activityLog?.record({
        kind: 'error',
        source: 'apply-moc-add',
        message: msg,
      });
      return 'error';
    }
  }

  /** Re-render the SuggestionsView + ActivityView if open; refresh the status bar. */
  async refreshSuggestionsView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(SUGGESTIONS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SuggestionsView) {
        await view.refresh();
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(ACTIVITY_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof ActivityView) {
        await view.refresh();
      }
    }
    await this.refreshStatusBar();
  }

  /**
   * Update the status bar pill — shows "✦ N suggestion(s)" when the
   * organization engine is on and the queue has at least one visible
   * (above min-confidence) item. Hidden when the engine is off OR the
   * queue is empty / entirely below threshold (avoid clutter when there's
   * nothing actionable).
   *
   * Called from `refreshSuggestionsView` (covers Apply/Skip/sweep paths)
   * and from `refreshOrganizationEngine` (covers settings toggles).
   */
  private async refreshStatusBar(): Promise<void> {
    const el = this.organizationStatusBarEl;
    if (el === null) {
      return;
    }
    if (this.suggestionQueue === null) {
      el.style.display = 'none';
      return;
    }
    const minConfidence = this.settings.organizationMinConfidence;
    const visible = await this.suggestionQueue.list({
      includeDeferred: true,
      minConfidence,
    });
    if (visible.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.setText(`✦ ${visible.length} suggestion${visible.length === 1 ? '' : 's'}`);
    el.style.display = '';
  }

  /**
   * (Re-)wire the organization engine based on current settings. Called
   * on plugin load + every time the user toggles a relevant setting.
   * Tears down + rebuilds the watcher when settings change.
   */
  refreshOrganizationEngine(): void {
    if (this.organizationSweepHandle !== null) {
      clearInterval(this.organizationSweepHandle);
      this.organizationSweepHandle = null;
    }
    if (this.organizationWatcher !== null) {
      this.organizationWatcher.stop();
      this.organizationWatcher = null;
    }

    if (!this.settings.organizationEnabled) {
      this.suggestionQueue = null;
      void this.refreshSuggestionsView();
      return;
    }

    // Engine needs: anthropic key (for classifier), HF retrieval (for grounding).
    if (this.settings.apiKey.length === 0) {
      new Notice('Sagittarius: organization engine needs an Anthropic API key.');
      this.suggestionQueue = null;
      return;
    }

    const adapter = new VaultAdapterImpl(this.app);
    this.suggestionQueue = new JsonSuggestionQueue({
      adapter,
      path: SUGGESTIONS_PATH,
    });

    // Lazy-build classifier + watcher. Needs retrieval + constitution +
    // a messages API. We piggyback on the agent bundle to get those —
    // they're already constructed when the user has a key.
    void this.bootOrganizationWatcher(adapter);
  }

  private async bootOrganizationWatcher(adapter: VaultAdapterImpl): Promise<void> {
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      // Will retry when the agent is next requested. The queue is still
      // live (so old suggestions render), just no new classifications.
      return;
    }
    if (bundle.deps.retrieval === undefined) {
      new Notice(
        'Sagittarius: organization needs a HuggingFace token for retrieval grounding.',
      );
      return;
    }
    const classifier = new OrganizationClassifier({
      adapter,
      retrieval: bundle.deps.retrieval,
      messages: bundle.deps.messages,
      constitution: bundle.deps.systemPromptParts.constitution,
      classifierModel: this.settings.organizationClassifierModel,
    });

    // v0.6.x — moc-add classifier + discovery (only when user populated
    // organizationMocFolders; empty array disables moc-add silently).
    let mocAddClassifier: MocAddClassifier | undefined;
    let mocDiscovery: MocDiscovery | undefined;
    if (this.settings.organizationMocFolders.length > 0) {
      mocAddClassifier = new MocAddClassifier({
        adapter,
        messages: bundle.deps.messages,
        constitution: bundle.deps.systemPromptParts.constitution,
        classifierModel: this.settings.organizationClassifierModel,
      });
      mocDiscovery = new MocDiscovery({
        adapter,
        mocFolders: this.settings.organizationMocFolders,
      });
    }
    const events: VaultEventEmitter = {
      onCreate: (handler) => {
        const cb = (...args: unknown[]): void => {
          const file = args[0] as TAbstractFile;
          if (file.path.endsWith('.md')) {
            handler(file.path);
          }
        };
        // Cast to the SDK's expected signature — Obsidian's typing uses
        // a generic `(...data: unknown[]) => unknown` overload here.
        this.app.vault.on('create', cb);
        return () => {
          this.app.vault.off('create', cb);
        };
      },
      onDelete: (handler) => {
        const cb = (...args: unknown[]): void => {
          const file = args[0] as TAbstractFile;
          if (file.path.endsWith('.md')) {
            handler(file.path);
          }
        };
        this.app.vault.on('delete', cb);
        return () => {
          this.app.vault.off('delete', cb);
        };
      },
    };
    if (this.suggestionQueue === null) {
      return;
    }
    this.organizationWatcher = new OrganizationWatcher({
      classifier,
      queue: this.suggestionQueue,
      events,
      adapter,
      enabled: true,
      watchedFolders: this.settings.organizationWatchedFolders,
      minConfidence: this.settings.organizationMinConfidence,
      classifierModel: this.settings.organizationClassifierModel,
      ...(this.activityLog !== null && { activityLog: this.activityLog }),
      ...(mocAddClassifier !== undefined &&
        mocDiscovery !== undefined && {
          mocAddClassifier,
          mocDiscovery,
        }),
    });
    this.organizationWatcher.start();

    const intervalSec = this.settings.organizationSweepIntervalSec;
    if (intervalSec > 0) {
      // Cast: @types/node + DOM lib overlap means setInterval is typed
      // NodeJS.Timeout here, but Obsidian's `registerInterval` + browser
      // `clearInterval` both want a number, which is what we actually
      // get at runtime.
      const handle = setInterval(() => {
        void this.runOrganizationSweep({ silent: true });
      }, intervalSec * 1000) as unknown as number;
      this.registerInterval(handle);
      this.organizationSweepHandle = handle;
    }

    await this.refreshSuggestionsView();
  }

  private async runSystemCheck(): Promise<void> {
    new Notice('Sagittarius: running system check…');
    let anthropic: MessagesAPI | null = null;
    if (this.settings.apiKey.length > 0) {
      const client = new Anthropic({ apiKey: this.settings.apiKey, dangerouslyAllowBrowser: true });
      anthropic = client.messages;
    }
    const adapter = new VaultAdapterImpl(this.app);
    const retrieval =
      this.engine && this.embedClient
        ? new RetrievalLayer({ selfEngine: this.engine, embedClient: this.embedClient })
        : null;
    if (!this.engine) {
      new Notice('Sagittarius: system check requires a loaded engine. Restart the plugin.');
      return;
    }
    const checker = new SystemCheck({
      manifestVersion: this.manifest.version,
      hasAnthropicKey: this.settings.apiKey.length > 0,
      hasHuggingFaceKey: this.settings.huggingfaceApiKey.length > 0,
      anthropic,
      defaultModel: this.settings.defaultModel,
      adapter,
      engine: this.engine,
      embedClient: this.embedClient ?? null,
      retrieval,
    });
    const report = await checker.run();
    new Notice(formatSummary(report));
    console.warn(formatReport(report));
  }

  /**
   * v0.8.1 — gather state from every Phase 5/6 subsystem and:
   *   - print a System-Check-style multi-line report to `console.warn`
   *     (full detail)
   *   - record a single `diagnostic` event in the activity stream
   *     (historical breadcrumb)
   *   - open the activity view so the operator can see the event
   *   - surface a one-line headline as a Notice
   *
   * Closes ADR-018 lesson 3 — the "DevTools eval doesn't scale" gap.
   */
  private async runOrganizationDiagnostics(): Promise<void> {
    const snap = await gatherDiagnostics({
      pluginVersion: this.manifest.version,
      settings: this.settings,
      activityLog: this.activityLog,
      suggestionQueue: this.suggestionQueue,
      engineLoaded: this.engine !== undefined,
      isIndexing: this.isIndexing(),
    });
    const report = formatDiagnosticsReport(snap);
    const summary = formatDiagnosticsSummary(snap);
    console.warn(report);
    if (this.activityLog !== null) {
      await this.activityLog.record({
        kind: 'diagnostic',
        summary,
        details: snap as unknown as Record<string, unknown>,
      });
      await this.activateActivityView();
      await this.refreshSuggestionsView();
    }
    new Notice(`Sagittarius diagnostics: ${summary} (full report in console).`);
  }

  /** Background-friendly auto-index runner. Kept silent on success. */
  private async autoIndexInBackground(): Promise<void> {
    if (!this.indexCoordinator) {
      return;
    }
    try {
      const result = await this.indexCoordinator.ensureBuilt();
      console.warn(
        `[sagittarius] auto-index: ${result.notesProcessed} notes, ${result.chunksAdded} chunks, ` +
          `${result.chunksSkipped} skipped, ${result.durationMs}ms.`,
      );
      await this.activityLog?.record({
        kind: 'index.built',
        notesProcessed: result.notesProcessed,
        chunksAdded: result.chunksAdded,
        chunksSkipped: result.chunksSkipped,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sagittarius] auto-index FAILED: ${msg}`);
      await this.activityLog?.record({
        kind: 'error',
        source: 'auto-index',
        message: msg,
      });
    }
  }

  /**
   * Build the persistent engine + retrieval infrastructure. Always loads
   * the SQLite engine. Skips EmbedClient / IndexCoordinator when no HF
   * token is set — chat-mode + 4 vault-API tools still work.
   */
  private async initializeIndexing(): Promise<void> {
    const adapter = new VaultAdapterImpl(this.app);

    // 1. Smoke-check the WASM/SQLite engine path before doing real work.
    const smoke = await openSqliteEngine({ writerVersion: this.manifest.version });
    smoke.close();

    // 2. Load (or create) the persistent engine.
    const persistence = new IndexPersistence(adapter, INDEX_DB_PATH);
    const buffer = await persistence.load();
    this.engine = await openSqliteEngine({
      ...(buffer ? { buffer } : {}),
      writerVersion: this.manifest.version,
    });

    // 3. Embed client only if HF token is set. No token = no retrieval,
    //    chat-mode-only — equivalent to v0.1.1 behavior.
    if (this.settings.huggingfaceApiKey.length === 0) {
      return;
    }

    this.embedClient = new EmbedClient(
      makeHfInferenceFactory({
        apiKey: this.settings.huggingfaceApiKey,
        fetch: makeObsidianRequestUrlNativeFetch(requestUrl),
      }),
    );
    this.indexCoordinator = new IndexCoordinator({
      adapter,
      embedClient: this.embedClient,
      engine: this.engine,
      persistence,
      excludePathPrefixes: this.indexExcludePrefixes(),
    });
  }

  private indexExcludePrefixes(): string[] {
    const prefixes = ['20-Corpus/', '.obsidian/', '.trash/'];
    if (this.settings.conversationLogPath.length > 0) {
      const trimmed = this.settings.conversationLogPath.replace(/\/$/, '');
      prefixes.push(`${trimmed}/`);
    }
    return prefixes;
  }

  /** Build the agent + tools. Registers search_vault iff retrieval is initialized. */
  private async buildAgent(): Promise<AgentBundle> {
    const adapter = new VaultAdapterImpl(this.app);
    const cache = new MetadataCacheImpl(this.app);

    // Phase 4 (v0.3.0): transaction log + write-tool context. The log
    // persists to a JSON file under the plugin's data dir; the ctx wraps
    // it for per-turn lifecycle (ConduitAgent opens/closes around each
    // chat() call). Both are constructed even if no write tools end up
    // registered — they're cheap and the agent always calls begin/end.
    const txLog = new JsonTransactionLog({
      adapter,
      path: TX_LOG_PATH,
      ...(this.activityLog !== null && { activityLog: this.activityLog }),
    });
    const writeCtx = new WriteToolContext(txLog);

    const tools = new ToolRegistry();
    tools.register(makeReadNoteTool(adapter));
    tools.register(makeListFolderTool(adapter));
    tools.register(makeGetBacklinksTool(cache));
    tools.register(makeGetGraphNeighborhoodTool(cache));

    // v0.3.0 write tools per ADR-016 D5. Each routes its proposal through
    // `this.approvalGate` (which delegates to whatever ChatView is open).
    tools.register(
      makeCreateNoteTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeAppendToNoteTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makePatchNoteTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeRewriteSectionTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeAddFrontmatterTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeMoveNoteTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeRenameNoteTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeLinkNotesTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
    );
    tools.register(
      makeFileAssetTool({
        adapter,
        gate: this.approvalGate,
        ctx: writeCtx,
        defaultFolder: this.settings.defaultAttachmentsFolder,
      }),
    );

    let retrieval: RetrievalLayer | undefined;
    if (this.engine && this.embedClient) {
      retrieval = new RetrievalLayer({
        selfEngine: this.engine,
        embedClient: this.embedClient,
      });
      tools.register(makeSearchVaultTool(retrieval));
    }

    const budgetPersistence = new PluginDataBudgetPersistence(this);
    const budget = await BudgetTracker.load(budgetPersistence, {
      maxTokensPerDay: this.settings.maxTokensPerDay,
      maxDollarsPerDay: this.settings.maxDollarsPerDay,
      tz: this.settings.budgetResetTimezone,
    });

    const logger = new ConversationLogger(adapter, this.settings.conversationLogPath);

    const systemPromptParts = await loadSystemPromptParts(adapter, {
      constitutionPath: CONSTITUTION_PATH,
      hangarVoicePath: HANGAR_VOICE_PATH,
    });

    const client = new Anthropic({
      apiKey: this.settings.apiKey,
      dangerouslyAllowBrowser: true,
    });

    const agentDeps: ConstructorParameters<typeof ConduitAgent>[0] = {
      messages: client.messages,
      tools,
      budget,
      logger,
      systemPromptParts,
      ctx: writeCtx,
    };
    if (retrieval) {
      agentDeps.retrieval = retrieval;
    }

    const agent = new ConduitAgent(agentDeps, {
      defaultModel: this.settings.defaultModel,
      fallbackModel: this.settings.fallbackModel,
      retrievalK: this.settings.retrievalK,
    });

    return { agent, deps: agentDeps };
  }
}
