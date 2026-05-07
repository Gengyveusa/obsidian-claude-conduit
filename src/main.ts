import Anthropic from '@anthropic-ai/sdk';
import { Notice, Plugin } from 'obsidian';

import { ConduitAgent } from './agent/ConduitAgent';
import { ToolRegistry } from './agent/ToolRegistry';
import { makeGetBacklinksTool } from './agent/tools/get_backlinks';
import { makeGetGraphNeighborhoodTool } from './agent/tools/get_graph_neighborhood';
import { makeListFolderTool } from './agent/tools/list_folder';
import { makeReadNoteTool } from './agent/tools/read_note';
import { makeSearchVaultTool } from './agent/tools/search_vault';
import { BudgetTracker } from './budget/BudgetTracker';
import { PluginDataBudgetPersistence } from './budget/PluginDataBudgetPersistence';
import { IndexCoordinator } from './indexing/IndexCoordinator';
import { IndexPersistence } from './indexing/IndexPersistence';
import { ConversationLogger } from './log/ConversationLogger';
import { MetadataCacheImpl } from './obsidian/MetadataCacheImpl';
import { loadSystemPromptParts } from './obsidian/SystemPromptLoader';
import { VaultAdapterImpl } from './obsidian/VaultAdapterImpl';
import { EmbedClient } from './retrieval/EmbedClient';
import { openSqliteEngine } from './retrieval/openEngine';
import { RetrievalLayer } from './retrieval/RetrievalLayer';
import type { SqliteEngine } from './retrieval/SqliteEngine';
import { SagittariusSettingTab } from './settings/SagittariusSettingTab';
import { DEFAULT_SETTINGS, type SagittariusSettings } from './settings/types';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { QuickQuestionModal } from './views/QuickQuestionModal';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';
const CONSTITUTION_PATH = 'THAD_MAN.md';
const HANGAR_VOICE_PATH = '21-Agents/concierge.md';
const INDEX_DB_PATH = '.obsidian/plugins/obsidian-claude-conduit/index.sqlite';

interface AgentBundle {
  agent: ConduitAgent;
}

/**
 * Sagittarius plugin entry point. Phase 3e-3c-2 wires the indexing
 * pipeline into the plugin: persistent SqliteEngine, EmbedClient,
 * RetrievalLayer, search_vault tool, IndexCoordinator with
 * auto-on-load (per Thad's call) + manual rebuild command.
 */
export default class SagittariusPlugin extends Plugin {
  settings: SagittariusSettings = DEFAULT_SETTINGS;
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
      id: 'rebuild-index',
      name: 'Rebuild retrieval index from scratch',
      callback: () => {
        void this.rebuildIndex();
      },
    });

    this.addCommand({
      id: 'build-index',
      name: 'Build retrieval index (incremental)',
      callback: () => {
        void this.runBuild({ rebuild: false });
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

    console.warn(`[sagittarius] ${PLUGIN_NAME} v${this.manifest.version} loaded.`);

    if (this.settings.indexingMode === 'auto') {
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

  /**
   * Rebuild the index from scratch (rebuild: true). Surfaces start +
   * complete via Notice.
   */
  async rebuildIndex(): Promise<void> {
    new Notice('Sagittarius: rebuilding index from scratch…');
    await this.runBuild({ rebuild: true });
  }

  /** Run a build via the coordinator and surface result via Notice. */
  private async runBuild(opts: { rebuild: boolean }): Promise<void> {
    if (!this.indexCoordinator) {
      new Notice('Sagittarius: indexing is not initialized — check console for errors.');
      return;
    }
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
   * Build the persistent engine + retrieval infrastructure. Runs once
   * on plugin load. Loads existing index.sqlite from disk if present,
   * else creates an empty engine (which migrate() populates with
   * schema_meta).
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

    // 3. Embed client + coordinator (model loads lazily on first encode).
    this.embedClient = new EmbedClient();
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

  /** Build the agent + all its deps. Called lazily when chat is first invoked. */
  private async buildAgent(): Promise<AgentBundle> {
    if (!this.engine || !this.embedClient) {
      throw new Error(
        'Sagittarius: indexing infrastructure is not initialized. Reload the plugin or check console for errors.',
      );
    }

    const adapter = new VaultAdapterImpl(this.app);
    const cache = new MetadataCacheImpl(this.app);

    const retrieval = new RetrievalLayer({
      selfEngine: this.engine,
      embedClient: this.embedClient,
    });

    const tools = new ToolRegistry();
    tools.register(makeReadNoteTool(adapter));
    tools.register(makeListFolderTool(adapter));
    tools.register(makeSearchVaultTool(retrieval));
    tools.register(makeGetBacklinksTool(cache));
    tools.register(makeGetGraphNeighborhoodTool(cache));

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

    const agent = new ConduitAgent(
      {
        messages: client.messages,
        tools,
        retrieval,
        budget,
        logger,
        systemPromptParts,
      },
      {
        defaultModel: this.settings.defaultModel,
        fallbackModel: this.settings.fallbackModel,
        retrievalK: this.settings.retrievalK,
      },
    );

    return { agent };
  }
}
