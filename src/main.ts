import Anthropic from '@anthropic-ai/sdk';
import { Notice, Plugin, type TAbstractFile, requestUrl } from 'obsidian';

import { ConduitAgent } from './agent/ConduitAgent';
import { ToolRegistry } from './agent/ToolRegistry';
import { makeAddFrontmatterTool } from './agent/tools/add_frontmatter';
import { makeAppendToNoteTool } from './agent/tools/append_to_note';
import { makeCreateNoteTool } from './agent/tools/create_note';
import { makeDeleteNoteTool } from './agent/tools/delete_note';
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
import { generateBearerToken, hashToken } from './mcp/auth';
import { McpServer } from './mcp/McpServer';
import { SagittariusSettingTab } from './settings/SagittariusSettingTab';
import { DEFAULT_SETTINGS, type SagittariusSettings } from './settings/types';
import {
  AnthropicDuplicateLlmJudge,
  AnthropicTagNormalizeLlmJudge,
} from './curator/AnthropicLlmJudge';
import { CuratorOrchestrator } from './curator/CuratorOrchestrator';
import { findingToSuggestion } from './curator/findingToSuggestion';
import { RetrievalSimilarityFinder } from './curator/RetrievalSimilarityFinder';
import { makeBrokenLinkRule } from './curator/rules/BrokenLinkRule';
import { makeDuplicateCandidateRule } from './curator/rules/DuplicateCandidateRule';
import { makeMissingFrontmatterRule } from './curator/rules/MissingFrontmatterRule';
import { makeOrphanRule } from './curator/rules/OrphanRule';
import { makeStaleNoteRule } from './curator/rules/StaleNoteRule';
import { makeTagNormalizeRule } from './curator/rules/TagNormalizeRule';
import { JsonSkipPatternStore, type SkipPatternStore } from './curator/SkipPatternStore';
import { buildTagRenameOps } from './curator/tagRename';
import { VaultCorpus } from './curator/VaultCorpus';
import { MocAddClassifier } from './organization/MocAddClassifier';
import { MocDiscovery } from './organization/MocDiscovery';
import { OrganizationClassifier } from './organization/OrganizationClassifier';
import {
  OrganizationWatcher,
  type VaultEventEmitter,
} from './organization/OrganizationWatcher';
import { JsonSuggestionQueue, type SuggestionQueue } from './organization/SuggestionQueue';
import type {
  AddFrontmatterSuggestion,
  ArchiveStaleSuggestion,
  BrokenLinkFixSuggestion,
  DuplicateCandidateSuggestion,
  MocAddSuggestion,
  NormalizeTagSuggestion,
  RouteSuggestion,
} from './organization/types';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { QuickQuestionModal } from './views/QuickQuestionModal';
import { ActivityView, ACTIVITY_VIEW_TYPE } from './views/ActivityView';
import {
  ExternalProposalsView,
  EXTERNAL_PROPOSALS_VIEW_TYPE,
} from './views/ExternalProposalsView';
import { DraftsView, DRAFTS_VIEW_TYPE } from './views/DraftsView';
import { NewDraftModal } from './views/NewDraftModal';
import { SuggestionsView, SUGGESTIONS_VIEW_TYPE, destinationPathFor } from './views/SuggestionsView';
import {
  openDuplicateMergeModal,
  type DuplicateMergeChoice,
} from './views/DuplicateMergeModal';
import { UndoConfirmModal } from './views/UndoConfirmModal';
import {
  makeDraftSuggestionRule,
  type DraftSuggestionPayload,
} from './curator/rules/DraftSuggestionRule';
import type { CuratorFinding } from './curator/types';
import { verifyCitations, type CitationDriftReport } from './drafts/citationDrift';
import { AnthropicDraftingEngine, draftToFileContent } from './drafts/DraftingEngine';
import { DraftStore } from './drafts/DraftStore';
import { promotedPathFor } from './drafts/paths';
import { LiveMemoryProvider } from './memory/LiveMemoryProvider';
import { CallbackApprovalGate } from './writes/CallbackApprovalGate';
import { ExternalProposalQueue } from './writes/ExternalProposalQueue';
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
const CURATOR_SKIP_PATTERNS_PATH =
  '.obsidian/plugins/obsidian-claude-conduit/curator-skip-patterns.json';

/**
 * v1.0.5 — Suggestion kinds produced by the curator. The
 * `SkipPatternStore` only records signatures for these (Phase 5
 * `route` / `moc-add` are not curator output and stay unfiltered).
 */
const CURATOR_SUGGESTION_KINDS: ReadonlySet<string> = new Set([
  'broken-link-fix',
  'archive-stale',
  'add-frontmatter',
  'stale-review',
  'duplicate-candidate',
  'normalize-tag',
]);

/** True iff a suggestion kind originated from the Phase 7 curator. */
export function isCuratorSuggestionKind(kind: string): boolean {
  return CURATOR_SUGGESTION_KINDS.has(kind);
}

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
   * Phase 6.7 (v1.1.0) — pending-proposal store for MCP-driven writes
   * per ADR-025 D2 (c) + D4 (b). Constructed unconditionally because
   * it's cheap (empty map + listener set) and the `CallbackApprovalGate`
   * routes external proposals here once `setRoutingDeps()` is called
   * after `buildAgent()`. When the MCP write-side is off (master toggle
   * off), nothing enqueues — the queue just sits empty.
   */
  readonly externalProposalQueue: ExternalProposalQueue = new ExternalProposalQueue();
  /**
   * Phase 8 (v1.2.0) — discovery + metadata layer for the Drafts side
   * panel per ADR-026 D5 (a). Constructed in `onload` once the
   * `VaultAdapter` is available; `null` before that.
   */
  draftStore: DraftStore | null = null;
  /**
   * Phase 9 (v1.3.0) — CLAUDE.md cascade per ADR-029. Constructed
   * lazily on first `getAgentBundle()` call (needs the API key for
   * the bundle to exist; provider itself only needs the adapter +
   * settings accessors). The status bar pill and chat footer read
   * `this.memoryProvider.lastResult` to render the most recent
   * cascade.
   */
  memoryProvider: LiveMemoryProvider | null = null;
  private memoryStatusBarEl: HTMLElement | null = null;
  /**
   * Phase 8 (v1.2.0) — status bar pill showing the count of files
   * under `_drafts/` per ADR-026 D5 (a). Created in `onload`;
   * refreshed on vault create/delete/rename and on plugin load.
   * Hides itself when no drafts exist.
   */
  private draftsStatusBarEl: HTMLElement | null = null;
  /**
   * Phase 6.7 (v1.1.0) — status bar pill showing pending external
   * proposal count per ADR-025 D4 (c). Created in `onload`; updated
   * on every `externalProposalQueue.onChange()`. Clicking opens the
   * `ExternalProposalsView` panel.
   */
  private externalProposalsStatusBarEl: HTMLElement | null = null;
  private externalProposalsQueueUnsubscribe: (() => void) | null = null;
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
  /**
   * v1.0.5 — Curator skip-pattern persistence per ADR-022 D7. Exposed
   * on the plugin so `SuggestionsView.handleSkip` can `.record()` the
   * `(kind, notePath)` signature when a curator-derived suggestion is
   * skipped. Always non-null after `onload` (the store itself is cheap;
   * an empty curator config just means it's never queried).
   */
  curatorSkipPatterns: SkipPatternStore | null = null;
  private organizationWatcher: OrganizationWatcher | null = null;
  private organizationSweepHandle: number | null = null;
  /**
   * Phase 7 v1.0.3 — scheduled curator sweep interval handle. Set via
   * `refreshCuratorSchedule()`; cleared in `onunload`.
   */
  private curatorScheduleHandle: number | null = null;
  private organizationStatusBarEl: HTMLElement | null = null;
  private agentBundle: AgentBundle | null = null;
  /**
   * Phase 6.5 (v0.9.0 PR 4) — MCP bridge instance. Constructed lazily
   * in `refreshMcpServer()` when `settings.mcpEnabled` flips on and
   * the token is configured. Null when the bridge is off.
   */
  private mcpServer: McpServer | null = null;
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

    // v1.0.5 — Curator skip-pattern store (ADR-022 D7). Always
    // instantiated; queried by `runCurator` and written by
    // `SuggestionsView.handleSkip` only for curator suggestion kinds.
    this.curatorSkipPatterns = new JsonSkipPatternStore({
      adapter: new VaultAdapterImpl(this.app),
      path: CURATOR_SKIP_PATTERNS_PATH,
    });

    // Phase 8 (v1.2.0) — drafts store per ADR-026 D5 (a). Cheap (no
    // I/O on construction); the side panel + status bar pill query
    // it on demand.
    this.draftStore = new DraftStore({ adapter: new VaultAdapterImpl(this.app) });

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(
      SUGGESTIONS_VIEW_TYPE,
      (leaf) => new SuggestionsView(leaf, this),
    );
    this.registerView(
      EXTERNAL_PROPOSALS_VIEW_TYPE,
      (leaf) => new ExternalProposalsView(leaf, this),
    );
    this.registerView(DRAFTS_VIEW_TYPE, (leaf) => new DraftsView(leaf, this));
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
      id: 'run-curator',
      name: 'Run curator',
      callback: () => {
        void this.runCurator();
      },
    });

    this.addCommand({
      id: 'test-mcp-connection',
      name: 'Test MCP connection',
      callback: () => {
        void this.testMcpConnection();
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

    // Phase 6.7 (v1.1.0) — external proposals status bar pill per
    // ADR-025 D4 (c). Always present; hides itself when the queue is
    // empty so it never clutters the bar when nothing's pending.
    this.externalProposalsStatusBarEl = this.addStatusBarItem();
    this.externalProposalsStatusBarEl.addClass('sagittarius-status-bar');
    this.externalProposalsStatusBarEl.style.cursor = 'pointer';
    this.externalProposalsStatusBarEl.addEventListener('click', () => {
      void this.activateExternalProposalsView();
    });
    this.externalProposalsStatusBarEl.setAttribute(
      'aria-label',
      'Sagittarius external proposals — click to open panel',
    );
    this.externalProposalsStatusBarEl.style.display = 'none';

    // Phase 8 (v1.2.0) — drafts status bar pill per ADR-026 D5 (a).
    // Lives next to the external-proposals pill. Hides when empty.
    this.draftsStatusBarEl = this.addStatusBarItem();
    this.draftsStatusBarEl.addClass('sagittarius-status-bar');
    this.draftsStatusBarEl.style.cursor = 'pointer';
    this.draftsStatusBarEl.addEventListener('click', () => {
      void this.activateDraftsView();
    });
    this.draftsStatusBarEl.setAttribute(
      'aria-label',
      'Sagittarius drafts — click to open panel',
    );
    this.draftsStatusBarEl.style.display = 'none';
    void this.refreshDraftsStatusBar();
    // Refresh the pill on any vault change so promote/discard/external
    // edits show up instantly. `registerEvent` ensures unload cleans
    // these up. Obsidian's vault event API has per-event-name
    // overloads so we register each one separately.
    const pillRefresh = (): void => {
      void this.refreshDraftsStatusBar();
    };
    this.registerEvent(this.app.vault.on('create', pillRefresh));
    this.registerEvent(this.app.vault.on('delete', pillRefresh));
    this.registerEvent(this.app.vault.on('rename', pillRefresh));

    // Phase 9 (v1.3.0) — memory status bar pill per ADR-029 D7.
    // Shows the cascade size for the currently-active file at a
    // glance; click opens a modal listing what would load if the
    // user sent a chat right now.
    this.memoryStatusBarEl = this.addStatusBarItem();
    this.memoryStatusBarEl.addClass('sagittarius-status-bar');
    this.memoryStatusBarEl.style.cursor = 'pointer';
    this.memoryStatusBarEl.setAttribute(
      'aria-label',
      'Sagittarius memory — click for cascade preview',
    );
    this.memoryStatusBarEl.addEventListener('click', () => {
      void this.openMemoryPreviewModal();
    });
    void this.refreshMemoryStatusBar();
    const memoryRefresh = (): void => {
      void this.refreshMemoryStatusBar();
    };
    this.registerEvent(this.app.vault.on('create', memoryRefresh));
    this.registerEvent(this.app.vault.on('modify', memoryRefresh));
    this.registerEvent(this.app.vault.on('delete', memoryRefresh));
    this.registerEvent(this.app.vault.on('rename', memoryRefresh));
    this.registerEvent(this.app.workspace.on('active-leaf-change', memoryRefresh));

    let lastQueueSize = 0;
    this.externalProposalsQueueUnsubscribe = this.externalProposalQueue.onChange(() => {
      const size = this.externalProposalQueue.size();
      // Detect new arrivals so we only fire the OS notification on
      // enqueue (not on respond / clearAll).
      const arrived = size > lastQueueSize;
      lastQueueSize = size;
      this.refreshExternalProposalsStatusBar();
      if (arrived && this.settings.mcpWriteNotifyOnQueue) {
        this.maybeFireExternalProposalNotification();
      }
    });

    this.addCommand({
      id: 'open-external-proposals',
      name: 'Open external proposals panel',
      callback: () => {
        void this.activateExternalProposalsView();
      },
    });

    // Phase 8 (v1.1.1) — generative drafting per ADR-026.
    this.addCommand({
      id: 'new-draft',
      name: 'New draft',
      callback: () => {
        void this.runNewDraft();
      },
    });
    this.addCommand({
      id: 'promote-draft',
      name: 'Promote draft',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = file !== null && file.path.startsWith('_drafts/');
        if (checking) {
          return ok;
        }
        if (ok && file !== null) {
          void this.runPromoteDraft(file.path);
        }
        return true;
      },
    });
    this.addCommand({
      id: 'open-drafts',
      name: 'Open drafts panel',
      callback: () => {
        void this.activateDraftsView();
      },
    });
    this.addCommand({
      id: 'suggest-drafts',
      name: 'Suggest drafts',
      callback: () => {
        void this.runSuggestDrafts();
      },
    });

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
    void this.refreshMcpServer();
    this.refreshCuratorSchedule();
  }

  /**
   * Phase 7 v1.0.3 — (re-)wire the scheduled curator sweep based on
   * current settings. Called on plugin load + whenever the user
   * toggles the relevant setting via `SagittariusSettingTab`.
   * Idempotent stop → start with the new interval.
   */
  refreshCuratorSchedule(): void {
    if (this.curatorScheduleHandle !== null) {
      clearInterval(this.curatorScheduleHandle);
      this.curatorScheduleHandle = null;
    }
    if (!this.settings.curatorEnabled) {
      return;
    }
    const intervalDays = this.settings.curatorSweepIntervalDays;
    if (intervalDays <= 0) {
      return;
    }
    const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
    const handle = setInterval(() => {
      void this.runCurator();
    }, intervalMs) as unknown as number;
    this.registerInterval(handle);
    this.curatorScheduleHandle = handle;
  }

  /**
   * Phase 6.5 (v0.9.0 PR 4) — (re-)wire the MCP bridge based on
   * current settings. Called on plugin load + whenever the user
   * toggles `mcpEnabled` / changes the port / regenerates the token.
   * Tears down the existing server (if any) before constructing a
   * fresh one with the current config.
   */
  async refreshMcpServer(): Promise<void> {
    if (this.mcpServer !== null) {
      await this.mcpServer.stop();
      this.mcpServer = null;
    }
    if (!this.settings.mcpEnabled) {
      return;
    }
    if (this.settings.mcpToken.length === 0) {
      new Notice(
        'Sagittarius: MCP enabled but no token configured. Generate one in settings.',
      );
      return;
    }
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: MCP needs an Anthropic API key.');
      return;
    }
    const server = new McpServer({
      tokenHash: this.settings.mcpToken,
      port: this.settings.mcpPort,
      allowedClients: this.settings.mcpAllowedClients,
      toolRegistry: bundle.deps.tools,
      pluginVersion: this.manifest.version,
      ...(this.activityLog !== null && { activityLog: this.activityLog }),
      // Phase 6.7 (v1.0.9) — wire write-side gating + the singleton
      // WriteToolContext so MCP-driven writes carry `source: 'mcp:<client>'`
      // on their Transaction per ADR-025 D5. The accessor reads
      // `this.settings` on each call so toggles in the settings UI
      // take effect immediately without restarting the MCP server.
      writeContext: bundle.deps.ctx,
      writeSettings: () => ({
        mcpWriteEnabled: this.settings.mcpWriteEnabled,
        mcpHighRiskToolsEnabled: this.settings.mcpHighRiskToolsEnabled,
        mcpWriteAllowedClients: this.settings.mcpWriteAllowedClients,
        mcpWritePathPrefixes: this.settings.mcpWritePathPrefixes,
        mcpWriteRateLimitPerHour: this.settings.mcpWriteRateLimitPerHour,
        mcpWriteQueueTimeoutMs: this.settings.mcpWriteQueueTimeoutMs,
      }),
    });
    try {
      await server.start();
      this.mcpServer = server;
      new Notice(`Sagittarius: MCP bridge listening on 127.0.0.1:${this.settings.mcpPort}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sagittarius] MCP bridge failed to start: ${msg}`);
      new Notice(`Sagittarius: MCP bridge failed to start — ${msg}`);
      await this.activityLog?.record({
        kind: 'error',
        source: 'mcp',
        message: `bridge failed to start: ${msg}`,
      });
    }
  }

  /**
   * v0.9.0 PR 4 — generate a fresh bearer token, hash it, persist the
   * hash, return the raw token for one-time display in settings.
   * Caller is responsible for showing it to the user.
   */
  async generateMcpToken(): Promise<string> {
    const token = generateBearerToken();
    this.settings.mcpToken = await hashToken(token);
    await this.saveSettings();
    return token;
  }

  /**
   * v0.9.1 — smoke test the running MCP bridge. Makes an authenticated
   * `initialize` JSON-RPC call to localhost:port. Surfaces a Notice
   * with pass/fail. Useful for verifying:
   *   - the bridge is bound to the configured port
   *   - the token in settings matches the one external clients hold
   *   - the protocol handshake produces a sensible `serverInfo`
   *
   * Tests the bridge from the same process — round-trips through
   * Node's `fetch`, the HTTP listener's auth, and the MCP handler.
   * Doesn't require a copy of the raw token; uses the configured
   * one via a fresh `generateMcpToken()` cycle? No — we don't have
   * the raw token anymore (only the hash). The test surfaces a
   * specific Notice telling the user to verify externally.
   */
  /**
   * Phase 8 (v1.1.1) — `Sagittarius: New draft` command handler per
   * ADR-026. Opens the topic modal, runs the drafting engine, and
   * routes the resulting body through the existing `create_note`
   * proposal so the diff card per ADR-016 D2 still gates the write.
   *
   * No new ADR-016 variant — the draft is just a `create_note` whose
   * path starts with `_drafts/` (D9 (a)).
   */
  private async runNewDraft(initialTopic = ''): Promise<void> {
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key in Settings → Sagittarius first.');
      return;
    }
    if (bundle.deps.retrieval === undefined) {
      new Notice(
        'Sagittarius: retrieval layer not ready — set a HuggingFace token and build the index first.',
      );
      return;
    }
    const retrieval = bundle.deps.retrieval;

    const modal = new NewDraftModal(
      this.app,
      this.settings.draftsDefaultDestination,
      initialTopic,
    );
    const inputs = await modal.prompt();
    if (inputs === null) {
      return;
    }

    const engineDeps: ConstructorParameters<typeof AnthropicDraftingEngine>[0] = {
      messages: bundle.deps.messages,
      retrieval,
      budget: bundle.deps.budget,
      settings: () => ({
        draftingModel: this.settings.draftingModel,
        citationPolicy: this.settings.citationPolicy,
        draftsDefaultDestination: this.settings.draftsDefaultDestination,
        retrievalK: this.settings.retrievalK,
      }),
    };
    // Phase 9 (v1.3.3) — drafting engine reads the same CLAUDE.md
    // cascade as chat per ADR-029. Same provider instance; cascade
    // anchors on the active file at the moment New Draft is invoked.
    if (this.memoryProvider !== null) {
      engineDeps.memoryProvider = this.memoryProvider;
    }
    const engine = new AnthropicDraftingEngine(engineDeps);

    const notice = new Notice(`Sagittarius: drafting '${inputs.topic}'…`, 0);
    try {
      const spec = inputs.destinationFolder.length > 0
        ? { topic: inputs.topic, destinationFolder: inputs.destinationFolder }
        : { topic: inputs.topic };
      const draft = await engine.generate(spec);
      notice.hide();
      if (draft.strictFallback) {
        new Notice(
          'Sagittarius: drafting fell back from strict mode — review the draft for unsupported claims before promoting.',
          10_000,
        );
      }
      // Open the chat panel so its diff card surfaces the proposal —
      // preserves ADR-016 D2 ("every write through the diff card").
      // The user accepts/rejects in the panel; the proposal queue
      // routing is bypassed because the transaction source stays
      // undefined (in-app).
      await this.activateChatView();
      await bundle.deps.tools.execute('create_note', {
        path: draft.path,
        content: draftToFileContent(draft),
      });
      new Notice(`Sagittarius: draft proposal sent to the chat panel — review and accept.`);
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: drafting failed — ${msg}`);
    }
  }

  /**
   * Phase 8 (v1.1.1) — `Sagittarius: Promote draft` command handler.
   * Active when the current file is under `_drafts/`. Routes through
   * `move_note` so the user sees a path-rename diff card (ADR-016 D2
   * invariant) and Obsidian's metadata cache auto-rewrites wikilinks.
   */
  /**
   * Phase 9.x (v1.4.0) — `Sagittarius: Suggest drafts` command.
   * Runs the pure `DraftSuggestionRule` over the vault corpus and
   * surfaces a modal listing every cluster of N+ tagged notes
   * lacking a synthesis. Each row gets a "Draft this" button that
   * opens `NewDraftModal` pre-filled with the suggested topic.
   *
   * Standalone (not yet wired into the curator orchestrator) per
   * the v1.4.0 scope decision — full curator-orchestrator
   * integration deferred to v1.4.x once the suggestion shape
   * stabilizes from real use.
   */
  private async runSuggestDrafts(): Promise<void> {
    const adapter = new VaultAdapterImpl(this.app);
    const cache = new MetadataCacheImpl(this.app);
    const corpus = new VaultCorpus(adapter, cache);
    const rule = makeDraftSuggestionRule({
      minNotes: this.settings.draftSuggestionMinNotes,
    });
    const notice = new Notice('Sagittarius: scanning vault for draft candidates…', 0);
    let findings: CuratorFinding[];
    try {
      findings = await rule.detect(corpus);
    } catch (err) {
      notice.hide();
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: draft suggestion failed — ${msg}`);
      return;
    }
    notice.hide();

    const { Modal } = await import('obsidian');
    const modal = new Modal(this.app);
    modal.titleEl.setText('Sagittarius — draft suggestions');
    const { contentEl } = modal;
    contentEl.empty();

    if (findings.length === 0) {
      contentEl.createEl('p', {
        text:
          `No draft candidates. Either every tag with ${this.settings.draftSuggestionMinNotes}+ notes ` +
          'already has a synthesis, or no tag clusters meet the threshold. ' +
          'Lower the threshold in Settings → Sagittarius → Generative drafting if you want broader suggestions.',
      });
    } else {
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text:
          `${findings.length} candidate${findings.length === 1 ? '' : 's'} ` +
          `(tag clusters with ≥${this.settings.draftSuggestionMinNotes} notes lacking a synthesis). ` +
          'Click "Draft this" to open the New Draft modal pre-filled with the suggested topic.',
      });
      // Sort severity desc — highest-priority first.
      const sorted = [...findings].sort((a, b) => b.severity - a.severity);
      for (const finding of sorted) {
        const payload = finding.payload as unknown as DraftSuggestionPayload;
        const row = contentEl.createDiv({ cls: 'sagittarius-draft-suggestion-row' });
        row.style.padding = '0.5em 0';
        row.style.borderTop = '1px solid var(--background-modifier-border)';
        const title = row.createDiv({ cls: 'sagittarius-draft-suggestion-title' });
        title.setText(`#${payload.tag} (${payload.memberCount} notes)`);
        title.style.fontWeight = '600';
        const reason = row.createDiv({ cls: 'sagittarius-draft-suggestion-reason' });
        reason.setText(finding.reason);
        reason.style.fontSize = '0.85em';
        reason.style.color = 'var(--text-muted)';
        const actions = row.createDiv();
        actions.style.marginTop = '0.4em';
        const btn = actions.createEl('button', { text: 'Draft this', cls: 'mod-cta' });
        btn.addEventListener('click', () => {
          modal.close();
          void this.runNewDraft(payload.suggestedTopic);
        });
      }
    }

    modal.open();
  }

  private async runPromoteDraft(draftPath: string): Promise<void> {
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key in Settings → Sagittarius first.');
      return;
    }
    let canonical: string;
    try {
      canonical = promotedPathFor(draftPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: ${msg}`);
      return;
    }

    // Phase 9 (v1.3.4) — citation drift verification per the v1.2.x
    // OQ1 follow-up. When the engine is loaded, re-verify each
    // `cited_chunks` entry against the current index. On drift,
    // surface a confirmation modal — operator can promote anyway
    // (citations are documentation, not contracts) or cancel.
    if (this.engine !== undefined) {
      try {
        const adapter = new VaultAdapterImpl(this.app);
        const report = await verifyCitations({
          adapter,
          draftPath,
          selfEngine: this.engine,
        });
        if (report.hasDrift) {
          const proceed = await this.confirmCitationDrift(draftPath, report);
          if (!proceed) {
            new Notice('Sagittarius: promotion cancelled.');
            return;
          }
        }
      } catch (err) {
        // Drift check failure shouldn't block promotion — log and proceed.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sagittarius] citation drift verification failed: ${msg}`);
      }
    }

    await this.activateChatView();
    try {
      await bundle.deps.tools.execute('move_note', {
        from: draftPath,
        to: canonical,
      });
      new Notice(`Sagittarius: promotion proposal sent to the chat panel — review and accept.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: promotion failed — ${msg}`);
    }
  }

  /**
   * Phase 9 (v1.3.4) — confirmation modal shown before promoting a
   * draft when `verifyCitations` reports drift. Resolves `true` if
   * the operator chooses to promote anyway, `false` on cancel.
   */
  private async confirmCitationDrift(
    draftPath: string,
    report: CitationDriftReport,
  ): Promise<boolean> {
    const { Modal } = await import('obsidian');
    const { formatDriftSummary } = await import('./drafts/citationDrift');
    return new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('Sagittarius — citation drift detected');
      const { contentEl } = modal;
      contentEl.empty();
      contentEl.createEl('p', {
        text: `Promoting \`${draftPath}\`. ${formatDriftSummary(report)}.`,
      });
      if (report.missingChunks.length > 0) {
        contentEl.createEl('h4', { text: 'Missing chunk indices (note rechunked since draft)' });
        const ul = contentEl.createEl('ul');
        for (const c of report.missingChunks) {
          ul.createEl('li', { text: `${c.notePath} — chunk ${c.chunkIndex}` });
        }
      }
      if (report.missingNotes.length > 0) {
        contentEl.createEl('h4', { text: 'Missing notes (deleted, moved, or never existed)' });
        const ul = contentEl.createEl('ul');
        for (const c of report.missingNotes) {
          ul.createEl('li', { text: `${c.notePath} — chunk ${c.chunkIndex}` });
        }
      }
      contentEl.createEl('p', {
        cls: 'setting-item-description',
        text:
          'Citations are documentation, not contracts — you can promote anyway. ' +
          'But the draft\'s `[[]]` markers may now point to stale or moved content.',
      });
      const buttons = contentEl.createDiv({ cls: 'sagittarius-drift-buttons' });
      buttons.style.display = 'flex';
      buttons.style.gap = '8px';
      buttons.style.justifyContent = 'flex-end';
      buttons.style.marginTop = '12px';
      const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
      const proceedBtn = buttons.createEl('button', {
        text: 'Promote anyway',
        cls: 'mod-warning',
      });
      let resolved = false;
      const finalize = (val: boolean): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve(val);
        modal.close();
      };
      cancelBtn.addEventListener('click', () => finalize(false));
      proceedBtn.addEventListener('click', () => finalize(true));
      modal.onClose = (): void => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      };
      modal.open();
    });
  }

  private async testMcpConnection(): Promise<void> {
    if (!this.settings.mcpEnabled) {
      new Notice('Sagittarius: MCP bridge is off. Enable it in settings first.');
      return;
    }
    if (this.mcpServer === null || !this.mcpServer.isRunning()) {
      new Notice('Sagittarius: MCP bridge is not running. Check settings + console.');
      return;
    }
    const port = this.mcpServer.boundPort() ?? this.settings.mcpPort;
    // We don't store the raw token — only its hash — so we can't make
    // the authenticated call ourselves. Instead, hit the endpoint
    // without a token: a healthy bridge responds with 401 (proves the
    // listener is up + auth is gating); a dead one returns a network
    // error (ECONNREFUSED).
    try {
      // Use Obsidian's `requestUrl` over raw `fetch` per community-plugin
      // reviewer guidelines, even though this is localhost (no CORS
      // concerns). `throw: false` so a 401 doesn't reject — we WANT
      // the 401 here as proof the listener + auth gate are alive.
      const res = await requestUrl({
        url: `http://127.0.0.1:${port}/`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        throw: false,
      });
      if (res.status === 401) {
        new Notice(
          `Sagittarius: MCP bridge OK on 127.0.0.1:${port} (401 without token = correct).`,
        );
      } else {
        new Notice(
          `Sagittarius: MCP bridge reachable but returned ${res.status} for unauthenticated probe — check logs.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: MCP bridge not reachable on 127.0.0.1:${port} — ${msg}`);
    }
  }

  override onunload(): void {
    if (this.organizationSweepHandle !== null) {
      clearInterval(this.organizationSweepHandle);
      this.organizationSweepHandle = null;
    }
    if (this.curatorScheduleHandle !== null) {
      clearInterval(this.curatorScheduleHandle);
      this.curatorScheduleHandle = null;
    }
    void this.mcpServer?.stop();
    this.mcpServer = null;
    this.organizationWatcher?.stop();
    this.organizationWatcher = null;
    this.suggestionQueue = null;
    this.agentBundle = null;
    // Phase 6.7 (v1.1.0) — reject every pending MCP write so the
    // background `tools/call` promises resolve (and the MCP client
    // sees a clean rejection) instead of dangling forever.
    this.externalProposalQueue.clearAll(
      'Sagittarius plugin unloaded before this proposal was reviewed.',
    );
    if (this.externalProposalsQueueUnsubscribe !== null) {
      this.externalProposalsQueueUnsubscribe();
      this.externalProposalsQueueUnsubscribe = null;
    }
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
   * Phase 9 (v1.3.0) — render the memory status bar pill per
   * ADR-029 D7. Pill shows "memory: NKB" when files would load,
   * "memory: none" when the cascade is empty, or "memory: off"
   * when the setting is disabled. Reads via the provider's
   * `preview()` so it doesn't pollute the agent's `lastResult`.
   */
  private async refreshMemoryStatusBar(): Promise<void> {
    const el = this.memoryStatusBarEl;
    if (el === null) {
      return;
    }
    if (!this.settings.memoryEnabled) {
      el.setText('memory: off');
      return;
    }
    // No provider yet (no API key) — show a placeholder that's
    // identical to the enabled-empty state so the pill doesn't
    // jiggle when the user later sets the key.
    if (this.memoryProvider === null) {
      el.setText('memory: —');
      return;
    }
    try {
      const result = await this.memoryProvider.preview();
      if (result.sections.length === 0) {
        el.setText('memory: none');
        return;
      }
      const kb = result.totalBytes < 1024
        ? `${result.totalBytes}B`
        : `${(result.totalBytes / 1024).toFixed(1)}KB`;
      const marker = result.budgetHit ? ' ⚠' : '';
      el.setText(`memory: ${kb}${marker}`);
    } catch {
      el.setText('memory: err');
    }
  }

  /**
   * Phase 9 (v1.3.0) — open a modal listing which CLAUDE.md files
   * the cascade would load right now, with byte counts and
   * truncation indicators. Click-triggered from the status bar pill
   * per ADR-029 D7.
   */
  private async openMemoryPreviewModal(): Promise<void> {
    const { Modal } = await import('obsidian');
    if (this.memoryProvider === null) {
      new Notice(
        'Sagittarius: memory provider not ready — set an API key in Settings first.',
      );
      return;
    }
    const result = await this.memoryProvider.preview();
    const modal = new Modal(this.app);
    modal.titleEl.setText('Sagittarius — memory cascade preview');
    const { contentEl } = modal;
    contentEl.empty();
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'These are the `CLAUDE.md` files Sagittarius would load if you ' +
        'sent a chat right now. Files load in vault-root-first order; ' +
        'edit any file to update its contents on the next turn.',
    });
    if (result.sections.length === 0) {
      contentEl.createEl('p', {
        text: this.settings.memoryEnabled
          ? 'No `CLAUDE.md` files match the current cascade. Create one at the vault root to start.'
          : 'Memory loading is OFF. Enable it in Settings → Sagittarius → Memory.',
      });
    } else {
      const list = contentEl.createEl('ul');
      for (const section of result.sections) {
        const li = list.createEl('li');
        const bytes = section.text.length < 1024
          ? `${section.text.length}B`
          : `${(section.text.length / 1024).toFixed(1)}KB`;
        const tag = section.truncated ? ' (truncated)' : '';
        li.setText(`${section.path} — ${bytes}${tag}`);
      }
      const total = result.totalBytes < 1024
        ? `${result.totalBytes}B`
        : `${(result.totalBytes / 1024).toFixed(1)}KB`;
      contentEl.createEl('p', { text: `Total: ${total} / ${this.settings.memoryMaxBytes}B budget` });
      if (result.budgetHit) {
        contentEl.createEl('p', {
          cls: 'mod-warning',
          text: 'Budget cap hit — some content was truncated. Raise the cap in Settings or tighten your `CLAUDE.md` files.',
        });
      }
    }
    modal.open();
  }

  /** Open the drafts side panel (creates a leaf if missing). */
  async activateDraftsView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DRAFTS_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice('Sagittarius: could not open drafts panel.');
      return;
    }
    await leaf.setViewState({ type: DRAFTS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Phase 8 (v1.2.0) — update the drafts status bar pill text +
   * visibility based on the current draft count per ADR-026 D5 (a).
   * Triggered on plugin load and every vault create/delete/rename.
   */
  private async refreshDraftsStatusBar(): Promise<void> {
    const el = this.draftsStatusBarEl;
    const store = this.draftStore;
    if (el === null || store === null) {
      return;
    }
    const count = await store.size();
    if (count === 0) {
      el.style.display = 'none';
      el.setText('');
      return;
    }
    el.style.display = '';
    el.setText(`Sagittarius: ${count} draft${count === 1 ? '' : 's'}`);
  }

  /** Open the external proposals side panel (creates a leaf if missing). */
  async activateExternalProposalsView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(EXTERNAL_PROPOSALS_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      new Notice('Sagittarius: could not open external proposals panel.');
      return;
    }
    await leaf.setViewState({ type: EXTERNAL_PROPOSALS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Phase 6.7 (v1.1.0) — fire a native OS notification when a new
   * external proposal enqueues per ADR-025 D3. Click focuses Obsidian
   * + opens the panel. Degrades gracefully when the `Notification`
   * API is unavailable (some Linux WMs) or permission is denied —
   * the status bar pill is the fallback indicator.
   */
  private maybeFireExternalProposalNotification(): void {
    const NotifCtor = (globalThis as { Notification?: typeof Notification }).Notification;
    if (typeof NotifCtor !== 'function') {
      return; // Platform doesn't expose the API; fall back to status bar.
    }
    // Permission can be 'granted', 'denied', or 'default'. 'default'
    // means we need to request it; we do so once per proposal arrival
    // because the user expects a notification — denial is sticky.
    const fire = (): void => {
      const pending = this.externalProposalQueue.pending();
      const latest = pending[pending.length - 1];
      const sourceLabel = latest === undefined ? 'an MCP client' : prettifyMcpSource(latest.source);
      const body =
        latest === undefined
          ? 'A write proposal is waiting for review.'
          : `${sourceLabel} wants to ${latest.proposal.toolName.replace(/_/g, ' ')}. Click to review.`;
      try {
        const notif = new NotifCtor('Sagittarius — write proposal pending', { body });
        notif.onclick = (): void => {
          void this.activateExternalProposalsView();
        };
      } catch {
        // Some Linux WMs throw despite reporting 'granted'. Pill is the fallback.
      }
    };
    if (NotifCtor.permission === 'granted') {
      fire();
      return;
    }
    if (NotifCtor.permission === 'denied') {
      return;
    }
    void NotifCtor.requestPermission().then((perm) => {
      if (perm === 'granted') {
        fire();
      }
    });
  }

  /**
   * Phase 6.7 (v1.1.0) — update the status bar pill text + visibility
   * based on the current external-proposal queue size per ADR-025 D4 (c).
   * Subscribed via `externalProposalQueue.onChange` in `onload`.
   */
  private refreshExternalProposalsStatusBar(): void {
    const el = this.externalProposalsStatusBarEl;
    if (el === null) {
      return;
    }
    const count = this.externalProposalQueue.size();
    if (count === 0) {
      el.style.display = 'none';
      el.setText('');
      return;
    }
    el.style.display = '';
    el.setText(`Sagittarius: ${count} pending`);
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

  /**
   * Phase 7 (v1.0.0) — apply a broken-link-fix suggestion. Removes the
   * `linkText` substring from the note's content via `patch_note`. Per
   * ADR-022 D4 the apply tool is `patch_note`; per ADR-016 D2 every
   * write still routes through the diff card.
   */
  async applyBrokenLinkFixSuggestion(
    s: BrokenLinkFixSuggestion,
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
      const readResult = (await bundle.deps.tools.execute('read_note', {
        path: s.notePath,
      })) as { content: string; mtime: number; hash: string } | null;
      if (readResult === null) {
        new Notice(`Sagittarius: note not found at ${s.notePath}.`);
        return 'error';
      }
      // Strip the broken link. patch_note does targeted find/replace via
      // anchorText (per Phase 4); use the full linkText as the anchor.
      const result = (await bundle.deps.tools.execute('patch_note', {
        path: s.notePath,
        anchorText: s.linkText,
        replacement: '',
        expectedMtime: readResult.mtime,
        expectedHash: readResult.hash,
      })) as { status: string; error?: string; reason?: string };
      if (result.status === 'applied') {
        await this.suggestionQueue.remove(s.id);
        await this.activityLog?.record({
          kind: 'suggestion.applied',
          suggestionId: s.id,
          suggestionKind: 'route',
          notePath: s.notePath,
          writeToolName: 'patch_note',
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
      console.warn(
        `[sagittarius] apply broken-link-fix failed: ${result.error ?? result.reason ?? ''}`,
      );
      return 'error';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sagittarius] apply broken-link-fix threw: ${msg}`);
      return 'error';
    }
  }

  /**
   * Phase 7 (v1.0.0) — apply an archive-stale suggestion. Moves the
   * note into `_archive/<year>/`. Per ADR-022 D4 the apply tool is
   * `move_note`; per ADR-016 D2 every write still routes through the
   * diff card.
   */
  async applyArchiveStaleSuggestion(
    s: ArchiveStaleSuggestion,
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
    const basename = s.notePath.split('/').pop() ?? s.notePath;
    const toPath = `${s.proposedFolder}/${basename}`;
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
      console.warn(
        `[sagittarius] apply archive-stale failed: ${result.error ?? result.reason ?? ''}`,
      );
      return 'error';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sagittarius] apply archive-stale threw: ${msg}`);
      return 'error';
    }
  }

  /**
   * Phase 7 (v1.0.1) — apply an add-frontmatter suggestion. Inserts
   * each missing field with an empty value via the `add_frontmatter`
   * tool (Phase 4). The user fills the values in afterward.
   */
  async applyAddFrontmatterSuggestion(
    s: AddFrontmatterSuggestion,
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
      const fieldsToAdd: Record<string, string> = {};
      for (const field of s.missingFields) {
        fieldsToAdd[field] = '';
      }
      const result = (await bundle.deps.tools.execute('add_frontmatter', {
        path: s.notePath,
        fields: fieldsToAdd,
      })) as { status: string; error?: string; reason?: string };
      if (result.status === 'applied') {
        await this.suggestionQueue.remove(s.id);
        await this.activityLog?.record({
          kind: 'suggestion.applied',
          suggestionId: s.id,
          suggestionKind: 'route',
          notePath: s.notePath,
          writeToolName: 'add_frontmatter',
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
      console.warn(
        `[sagittarius] apply add-frontmatter failed: ${result.error ?? result.reason ?? ''}`,
      );
      return 'error';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sagittarius] apply add-frontmatter threw: ${msg}`);
      return 'error';
    }
  }

  /**
   * Phase 7 v1.0.6 — apply a `normalize-tag` suggestion per ADR-024
   * follow-up. Scans every markdown note in the vault, finds each that
   * still uses a non-canonical cluster member, and proposes a
   * line-level `patch_note` rewriting those occurrences to the
   * canonical form. Each affected note routes through its own diff
   * card (ADR-016 D2 invariant). Tally is surfaced as a single Notice.
   *
   * Returns `{applied, rejected, errored, conflict, scanned, skipped}`:
   *   - `applied`: notes the user accepted in the diff card
   *   - `rejected`: notes the user rejected in the diff card
   *   - `errored`: read failures / tool errors / agent-bundle missing
   *   - `conflict`: file changed between read + propose
   *   - `scanned`: total .md paths walked
   *   - `skipped`: notes with zero rewriteable occurrences (no-op)
   */
  async applyNormalizeTagSuggestion(s: NormalizeTagSuggestion): Promise<{
    applied: number;
    rejected: number;
    errored: number;
    conflict: number;
    scanned: number;
    skipped: number;
  }> {
    const result = {
      applied: 0,
      rejected: 0,
      errored: 0,
      conflict: 0,
      scanned: 0,
      skipped: 0,
    };
    if (this.suggestionQueue === null) {
      new Notice('Sagittarius: organization engine is off.');
      return result;
    }
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key first.');
      return result;
    }
    const canonical = s.canonical.toLowerCase();
    const nonCanonical = new Set(
      s.cluster
        .map((t) => t.toLowerCase())
        .filter((t) => t !== canonical),
    );
    if (nonCanonical.size === 0) {
      new Notice('Sagittarius: nothing to canonicalize (canonical already matches).');
      return result;
    }
    const adapter = new VaultAdapterImpl(this.app);
    const corpus = new VaultCorpus(adapter, new MetadataCacheImpl(this.app));
    const allMd = await corpus.listAllMarkdown();
    result.scanned = allMd.length;

    for (const path of allMd) {
      const readResult = (await bundle.deps.tools.execute('read_note', {
        path,
      })) as { content: string; mtime: number; hash: string } | null;
      if (readResult === null) {
        // Note vanished between listing + read. Not an error worth
        // counting — just move on.
        continue;
      }
      const ops = buildTagRenameOps(readResult.content, nonCanonical, canonical);
      if (ops.length === 0) {
        result.skipped += 1;
        continue;
      }
      let tool: { status: string; error?: string; reason?: string };
      try {
        tool = (await bundle.deps.tools.execute('patch_note', {
          path,
          ops,
          expectedMtime: readResult.mtime,
          expectedHash: readResult.hash,
        })) as { status: string; error?: string; reason?: string };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[sagittarius] normalize-tag patch threw on ${path}: ${msg}`);
        result.errored += 1;
        continue;
      }
      if (tool.status === 'applied') {
        result.applied += 1;
        await this.activityLog?.record({
          kind: 'write.committed',
          toolName: 'patch_note',
          path,
        });
      } else if (tool.status === 'rejected') {
        result.rejected += 1;
      } else if (tool.status === 'conflict') {
        result.conflict += 1;
      } else {
        result.errored += 1;
      }
    }
    return result;
  }

  /**
   * Phase 7 v1.0.7 — apply a `duplicate-candidate` suggestion per
   * ADR-024 follow-up. Opens the `DuplicateMergeModal` so the user
   * picks the keeper (which note stays). Then runs two sequential
   * diff-card-gated writes:
   *
   *   1. `patch_note` on the keeper, appending the discard note's
   *      body under a `## Merged from [[discard]]` marker section.
   *   2. `delete_note` on the discard once the patch is applied.
   *
   * Failure modes:
   *   - User cancels modal → `'cancelled'`, suggestion stays in queue.
   *   - Patch rejected by user → `'rejected'`, suggestion stays.
   *   - Patch conflict / error → `'error'`, no delete attempted.
   *   - Patch applied but delete fails → `'error'` with a loud Notice;
   *     user can `Undo last write` to roll back the merge, then resolve
   *     the discard manually.
   *   - Both succeed → `'merged'`, suggestion removed from queue.
   */
  async applyDuplicateCandidateSuggestion(s: DuplicateCandidateSuggestion): Promise<{
    status: 'merged' | 'rejected' | 'cancelled' | 'error';
    keep?: string;
    discard?: string;
  }> {
    if (this.suggestionQueue === null) {
      new Notice('Sagittarius: organization engine is off.');
      return { status: 'error' };
    }
    const bundle = await this.getAgentBundle();
    if (bundle === null) {
      new Notice('Sagittarius: set your Anthropic API key first.');
      return { status: 'error' };
    }
    const adapter = new VaultAdapterImpl(this.app);
    let contentA: string;
    let contentB: string;
    try {
      contentA = await adapter.read(s.notePath);
      contentB = await adapter.read(s.otherPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Sagittarius: one of the duplicate notes is unreadable — ${msg}.`);
      return { status: 'error' };
    }

    const choice: DuplicateMergeChoice = await openDuplicateMergeModal(this.app, {
      pathA: s.notePath,
      previewA: contentA.slice(0, 800),
      pathB: s.otherPath,
      previewB: contentB.slice(0, 800),
      similarity: s.similarity,
    });
    if (choice === 'cancel') {
      return { status: 'cancelled' };
    }
    const keep = choice === 'keep-a' ? s.notePath : s.otherPath;
    const discard = choice === 'keep-a' ? s.otherPath : s.notePath;
    const discardContent = choice === 'keep-a' ? contentB : contentA;

    // Re-read the keeper through the tool layer so we get a fresh
    // mtime+hash bound to whatever's on disk right now.
    const readResult = (await bundle.deps.tools.execute('read_note', {
      path: keep,
    })) as { content: string; mtime: number; hash: string } | null;
    if (readResult === null) {
      new Notice(`Sagittarius: keeper note vanished — ${keep}.`);
      return { status: 'error', keep, discard };
    }

    const lineCount = readResult.content.split('\n').length;
    const mergedSection = [
      '',
      `## Merged from [[${stripMdSuffix(discard)}]]`,
      '',
      discardContent.trimEnd(),
      '',
    ].join('\n');

    const patchResult = (await bundle.deps.tools.execute('patch_note', {
      path: keep,
      ops: [{ kind: 'insert', afterLine: lineCount, content: mergedSection }],
      expectedMtime: readResult.mtime,
      expectedHash: readResult.hash,
    })) as { status: string; error?: string; reason?: string };

    if (patchResult.status === 'rejected') {
      return { status: 'rejected', keep, discard };
    }
    if (patchResult.status !== 'applied') {
      const why = patchResult.error ?? patchResult.reason ?? 'unknown';
      new Notice(`Sagittarius: merge patch failed on ${keep} — ${why}.`);
      return { status: 'error', keep, discard };
    }

    // Patch applied. Now propose the delete.
    const deleteResult = (await bundle.deps.tools.execute('delete_note', {
      path: discard,
    })) as { status: string; error?: string; reason?: string };

    if (deleteResult.status !== 'applied') {
      // Loud Notice — the merge happened but the discard didn't go.
      // The user can `Undo last write` (which restores the keeper to
      // its pre-merge content) or resolve the discard manually.
      const why = deleteResult.error ?? deleteResult.reason ?? 'unknown';
      new Notice(
        `Sagittarius: merged into ${keep} but ${discard} delete failed — ${why}. ` +
          'Run `Undo last write transaction` to roll back, or delete the file manually.',
        20_000,
      );
      return { status: 'error', keep, discard };
    }

    await this.suggestionQueue.remove(s.id);
    await this.activityLog?.record({
      kind: 'suggestion.applied',
      suggestionId: s.id,
      suggestionKind: 'route',
      notePath: keep,
      writeToolName: 'patch_note',
    });
    return { status: 'merged', keep, discard };
  }

  /**
   * Phase 7 (v1.0.0) — `Sagittarius: Run curator` command. Builds a
   * fresh orchestrator with the user's enabled rules, runs a sweep,
   * converts findings into Suggestions, enqueues them via the Phase 5
   * SuggestionQueue. Refreshes the panel + status bar. Surfaces a
   * single-line Notice with the counts.
   */
  async runCurator(): Promise<void> {
    if (!this.settings.curatorEnabled) {
      new Notice('Sagittarius: curator is off. Enable in settings.');
      return;
    }
    if (this.suggestionQueue === null) {
      new Notice('Sagittarius: organization engine is off — curator needs the suggestion queue.');
      return;
    }
    const adapter = new VaultAdapterImpl(this.app);
    const cache = new MetadataCacheImpl(this.app);
    const corpus = new VaultCorpus(adapter, cache);
    const orchestrator = new CuratorOrchestrator({ corpus });

    const rules = this.settings.curatorEnabledRules;
    if (rules['broken-link'] !== false) {
      orchestrator.register(makeBrokenLinkRule());
    }
    if (rules['orphan'] !== false) {
      orchestrator.register(
        makeOrphanRule({ staleThresholdDays: this.settings.curatorStaleNoteThresholdDays }),
      );
    }
    if (
      rules['missing-frontmatter'] !== false &&
      Object.keys(this.settings.curatorFolderSchemas).length > 0
    ) {
      orchestrator.register(
        makeMissingFrontmatterRule({ schemas: this.settings.curatorFolderSchemas }),
      );
    }
    if (rules['stale-note'] !== false) {
      orchestrator.register(
        makeStaleNoteRule({
          staleThresholdDays: this.settings.curatorStaleNoteThresholdDays * 2,
        }),
      );
    }

    // v1.0.4 — LLM-judged rules per ADR-024 follow-up. Each needs its
    // production-side adapter: an Anthropic client (apiKey set) for the
    // judge, and a loaded SQLite index (`engine`) for the similarity
    // finder. If a dep is missing we skip the rule rather than failing
    // the whole sweep — the pure rules above still run.
    let duplicateJudge: AnthropicDuplicateLlmJudge | null = null;
    let tagNormalizeJudge: AnthropicTagNormalizeLlmJudge | null = null;
    if (this.settings.apiKey.length > 0) {
      const client = new Anthropic({
        apiKey: this.settings.apiKey,
        dangerouslyAllowBrowser: true,
      });
      if (rules['duplicate-candidate'] !== false && this.engine !== undefined) {
        const finder = new RetrievalSimilarityFinder(this.engine);
        duplicateJudge = new AnthropicDuplicateLlmJudge(client.messages);
        orchestrator.register(
          makeDuplicateCandidateRule({
            similarityFinder: finder,
            llmJudge: duplicateJudge,
          }),
        );
      }
      if (rules['normalize-tag'] !== false) {
        tagNormalizeJudge = new AnthropicTagNormalizeLlmJudge(client.messages);
        orchestrator.register(
          makeTagNormalizeRule({ llmJudge: tagNormalizeJudge }),
        );
      }
    }

    if (orchestrator.registeredRuleNames().length === 0) {
      new Notice('Sagittarius: no curator rules enabled — nothing to do.');
      return;
    }

    new Notice('Sagittarius: running curator…');
    const outcome = await orchestrator.run({ maxPerSweep: this.settings.curatorMaxPerSweep });

    let enqueuedCount = 0;
    let skipFiltered = 0;
    for (const finding of outcome.enqueued) {
      const suggestion = findingToSuggestion(finding);
      if (suggestion === null) {
        continue;
      }
      // v1.0.5 — ADR-022 D7 trust-calibration: drop suggestions whose
      // (kind, notePath) matches a stored skip pattern from a previous
      // sweep. The store-side check uses startsWith so a `pathPrefix`
      // of `'10-Inbox/'` skips an entire folder.
      if (
        this.curatorSkipPatterns !== null &&
        (await this.curatorSkipPatterns.matches(suggestion.kind, suggestion.notePath))
      ) {
        skipFiltered += 1;
        continue;
      }
      const added = await this.suggestionQueue.add(suggestion);
      if (added) {
        enqueuedCount += 1;
        // Activity-stream `suggestionKind` is the v0.8.0 enum (`route` /
        // `moc-add`); v1.0.0 kinds map onto `route` since their apply
        // paths are write-style. PR 4 may widen this enum.
        let target = '';
        if (suggestion.kind === 'broken-link-fix') {
          target = suggestion.brokenTarget;
        } else if (suggestion.kind === 'archive-stale') {
          target = suggestion.proposedFolder;
        }
        await this.activityLog?.record({
          kind: 'suggestion.enqueued',
          suggestionId: suggestion.id,
          suggestionKind: 'route',
          notePath: suggestion.notePath,
          target,
          confidence: suggestion.confidence,
        });
      }
    }

    // v1.0.4 — one diagnostic per sweep, carrying per-rule LLM counts so
    // the activity stream answers "what did the curator spend tokens on
    // yesterday?" per ADR-024 follow-up. Pure-rule sweeps emit zero
    // counts; absent judge = rule not registered.
    const llmCalls: Record<string, number> = {};
    if (duplicateJudge !== null) {
      llmCalls['duplicate-candidate'] = duplicateJudge.callCount;
    }
    if (tagNormalizeJudge !== null) {
      llmCalls['normalize-tag'] = tagNormalizeJudge.callCount;
    }
    await this.activityLog?.record({
      kind: 'diagnostic',
      summary:
        `curator: rules=${outcome.rulesRun} detected=${outcome.totalDetected} ` +
        `enqueued=${enqueuedCount} skip-filtered=${skipFiltered} ` +
        `capped=${outcome.capped} errors=${outcome.errors.length}`,
      details: {
        scope: 'curator.swept',
        rulesRun: outcome.rulesRun,
        totalDetected: outcome.totalDetected,
        enqueued: enqueuedCount,
        skipFiltered,
        capped: outcome.capped,
        errors: outcome.errors,
        durationMs: outcome.durationMs,
        llmCalls,
      },
    });

    const skipNote = skipFiltered > 0 ? `, skip-filtered ${skipFiltered}` : '';
    new Notice(
      `Sagittarius: curator found ${outcome.totalDetected}, enqueued ${enqueuedCount}${skipNote}, ` +
        `capped ${outcome.capped}, errors ${outcome.errors.length}.`,
    );
    await this.refreshSuggestionsView();
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

    // Phase 6.7 (v1.1.0) — late-bind the routing deps on the singleton
    // approval gate per ADR-025 D4 (b). The gate now sees
    // `writeCtx.currentSource()` and routes external proposals to the
    // plugin-level `externalProposalQueue`. In-app chat (source =
    // undefined) keeps using the ChatView callback path.
    this.approvalGate.setRoutingDeps({
      ctx: writeCtx,
      externalQueue: this.externalProposalQueue,
    });

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
      makeDeleteNoteTool({ adapter, gate: this.approvalGate, ctx: writeCtx }),
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

    // Phase 9 (v1.3.0) — CLAUDE.md cascade per ADR-029. The provider
    // is constructed once per bundle but reads settings + workspace
    // state on every `collect()` so live toggles + active-file
    // changes take effect immediately (D6).
    if (this.memoryProvider === null) {
      this.memoryProvider = new LiveMemoryProvider({
        adapter,
        app: this.app,
        getEnabled: () => this.settings.memoryEnabled,
        getMaxBytes: () => this.settings.memoryMaxBytes,
      });
    }

    const agentDeps: ConstructorParameters<typeof ConduitAgent>[0] = {
      messages: client.messages,
      tools,
      budget,
      logger,
      systemPromptParts,
      ctx: writeCtx,
      memoryProvider: this.memoryProvider,
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

/** Strip a trailing `.md` from a vault path. Used to build clean `[[wikilinks]]`. */
function stripMdSuffix(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path;
}

/** Friendly label for an MCP source string in user-facing notifications. */
function prettifyMcpSource(source: string): string {
  if (source.startsWith('mcp:')) {
    const name = source.slice(4);
    return name.length === 0 ? 'an MCP client' : name;
  }
  return source;
}
