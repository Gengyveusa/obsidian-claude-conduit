import Anthropic from '@anthropic-ai/sdk';
import { Notice, Plugin } from 'obsidian';

import { ConduitAgent } from './agent/ConduitAgent';
import { ToolRegistry } from './agent/ToolRegistry';
import { makeGetBacklinksTool } from './agent/tools/get_backlinks';
import { makeGetGraphNeighborhoodTool } from './agent/tools/get_graph_neighborhood';
import { makeListFolderTool } from './agent/tools/list_folder';
import { makeReadNoteTool } from './agent/tools/read_note';
import { BudgetTracker } from './budget/BudgetTracker';
import { PluginDataBudgetPersistence } from './budget/PluginDataBudgetPersistence';
import { ConversationLogger } from './log/ConversationLogger';
import { MetadataCacheImpl } from './obsidian/MetadataCacheImpl';
import { loadSystemPromptParts } from './obsidian/SystemPromptLoader';
import { VaultAdapterImpl } from './obsidian/VaultAdapterImpl';
import { openSqliteEngine } from './retrieval/openEngine';
import { SagittariusSettingTab } from './settings/SagittariusSettingTab';
import { DEFAULT_SETTINGS, type SagittariusSettings } from './settings/types';
import { ChatView, CHAT_VIEW_TYPE } from './views/ChatView';
import { QuickQuestionModal } from './views/QuickQuestionModal';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';
const CONSTITUTION_PATH = 'THAD_MAN.md';
const HANGAR_VOICE_PATH = '21-Agents/concierge.md';

interface AgentBundle {
  agent: ConduitAgent;
}

/**
 * Sagittarius plugin entry point.
 *
 * v0.1 ships with chat-mode + the 4 vault-API tools (read_note,
 * list_folder, get_backlinks, get_graph_neighborhood). Semantic
 * retrieval (search_vault, vault-qa mode) is **deferred to v0.2**
 * per ADR-012 — three rounds of patching transformers.js's env
 * config didn't make it work in Obsidian's renderer, and the right
 * call was to ship what works rather than keep patching.
 *
 * The retrieval-layer source (Indexer, EmbedClient, RetrievalLayer,
 * IndexCoordinator) stays in src/ for v0.2; main.ts simply doesn't
 * import or wire it. Bundle drops back to ~926 KB.
 */
export default class SagittariusPlugin extends Plugin {
  settings: SagittariusSettings = DEFAULT_SETTINGS;
  private agentBundle: AgentBundle | null = null;

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

    // Smoke-check the SQLite engine path. Even though we don't use it
    // for retrieval in v0.1, it stays as a sanity probe for the bundle
    // health and is wired up for v0.2.
    try {
      const engine = await openSqliteEngine({ writerVersion: this.manifest.version });
      const meta = engine.getSchemaMeta();
      engine.close();
      console.warn(
        `[sagittarius] ${PLUGIN_NAME} v${this.manifest.version} loaded. ` +
          `SQLite engine OK (schema v${meta.schemaVersion}, ${meta.vectorDim}-d ${meta.model}).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sagittarius] SQLite engine smoke check FAILED: ${msg}`);
      new Notice(`Sagittarius: SQLite engine failed to initialize. Check the developer console.`);
    }
  }

  override onunload(): void {
    this.agentBundle = null;
    console.warn(`[sagittarius] ${PLUGIN_NAME} unloaded.`);
  }

  /** v0.1: indexing is deferred. Always returns false. */
  isIndexing(): boolean {
    return false;
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
   * Build the agent + the 4 v0.1 tools. No retrieval, no embed client,
   * no transformers.js — those are v0.2 per ADR-012.
   */
  private async buildAgent(): Promise<AgentBundle> {
    const adapter = new VaultAdapterImpl(this.app);
    const cache = new MetadataCacheImpl(this.app);

    const tools = new ToolRegistry();
    tools.register(makeReadNoteTool(adapter));
    tools.register(makeListFolderTool(adapter));
    tools.register(makeGetBacklinksTool(cache));
    tools.register(makeGetGraphNeighborhoodTool(cache));
    // search_vault is intentionally omitted in v0.1 (ADR-012).

    const persistence = new PluginDataBudgetPersistence(this);
    const budget = await BudgetTracker.load(persistence, {
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
