import Anthropic from '@anthropic-ai/sdk';
import { Notice, Plugin, requestUrl } from 'obsidian';

import { ConduitAgent } from './agent/ConduitAgent';
import { ToolRegistry } from './agent/ToolRegistry';
import { makeAppendToNoteTool } from './agent/tools/append_to_note';
import { makeCreateNoteTool } from './agent/tools/create_note';
import { makePatchNoteTool } from './agent/tools/patch_note';
import { makeGetBacklinksTool } from './agent/tools/get_backlinks';
import { makeGetGraphNeighborhoodTool } from './agent/tools/get_graph_neighborhood';
import { makeListFolderTool } from './agent/tools/list_folder';
import { makeReadNoteTool } from './agent/tools/read_note';
import { makeSearchVaultTool } from './agent/tools/search_vault';
import { BudgetTracker } from './budget/BudgetTracker';
import { PluginDataBudgetPersistence } from './budget/PluginDataBudgetPersistence';
import type { MessagesAPI } from './agent/ConduitAgent';
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
import { SagittariusSettingTab } from './settings/SagittariusSettingTab';
import { DEFAULT_SETTINGS, type SagittariusSettings } from './settings/types';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { QuickQuestionModal } from './views/QuickQuestionModal';
import { CallbackApprovalGate } from './writes/CallbackApprovalGate';
import { JsonTransactionLog } from './writes/TransactionLog';
import { WriteToolContext } from './writes/WriteToolContext';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';
const CONSTITUTION_PATH = 'THAD_MAN.md';
const HANGAR_VOICE_PATH = '21-Agents/concierge.md';
const INDEX_DB_PATH = '.obsidian/plugins/obsidian-claude-conduit/index.sqlite';
const TX_LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/transactions.json';

interface AgentBundle {
  agent: ConduitAgent;
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
  private agentBundle: AgentBundle | null = null;
  private engine?: SqliteEngine;
  private embedClient?: EmbedClient;
  private indexCoordinator?: IndexCoordinator;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SagittariusSettingTab(this.app, this));

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

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
      id: 'system-check',
      name: 'System check',
      callback: () => {
        void this.runSystemCheck();
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
  }

  override onunload(): void {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sagittarius] auto-index FAILED: ${msg}`);
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

    return { agent };
  }
}
