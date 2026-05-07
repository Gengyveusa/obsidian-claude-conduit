import { type App, PluginSettingTab, Setting } from 'obsidian';

import type SagittariusPlugin from '../main';

/**
 * Obsidian PluginSettingTab for Sagittarius. Renders the settings UI per
 * docs/02_SPEC.md §5.5: API config, retrieval, budget, conversation log,
 * Voyage opt-in (disabled in v0.1).
 *
 * Every onChange writes to plugin.settings + calls plugin.saveSettings() —
 * Obsidian persists to <plugin-dir>/data.json automatically via saveData.
 *
 * @example
 *   this.addSettingTab(new SagittariusSettingTab(this.app, this));
 */
export class SagittariusSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SagittariusPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Sagittarius — Claude Conduit' });
    containerEl.createEl('p', {
      text:
        'Native Obsidian plugin for Claude. v0.1 = read-only chat with retrieval grounding. ' +
        'Diff-first writes coming in v0.5.',
    });

    this.renderApiSection(containerEl);
    this.renderRetrievalSection(containerEl);
    this.renderBudgetSection(containerEl);
    this.renderLogSection(containerEl);
    this.renderVoyageSection(containerEl);
  }

  private renderApiSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Anthropic API' });

    new Setting(parent)
      .setName('API key')
      .setDesc(
        'Your Anthropic API key. Stored in this plugin\'s data directory; never sent ' +
          'anywhere except api.anthropic.com. Make sure your vault gitignores ' +
          '.obsidian/plugins/obsidian-claude-conduit/data.json.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('sk-ant-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(parent)
      .setName('Default model')
      .setDesc('The model to use for normal turns.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('claude-sonnet-4-6', 'Claude Sonnet 4.6 (recommended)')
          .addOption('claude-opus-4-7', 'Claude Opus 4.7')
          .addOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5')
          .setValue(this.plugin.settings.defaultModel)
          .onChange(async (value) => {
            this.plugin.settings.defaultModel =
              value as typeof this.plugin.settings.defaultModel;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName('Fallback model')
      .setDesc("Used when the default model returns 503 (overloaded). One retry only.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption('claude-sonnet-4-6', 'Claude Sonnet 4.6')
          .addOption('claude-opus-4-7', 'Claude Opus 4.7 (recommended)')
          .addOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5')
          .setValue(this.plugin.settings.fallbackModel)
          .onChange(async (value) => {
            this.plugin.settings.fallbackModel =
              value as typeof this.plugin.settings.fallbackModel;
            await this.plugin.saveSettings();
          }),
      );
  }

  private renderRetrievalSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Retrieval' });

    new Setting(parent)
      .setName('Indexing mode')
      .setDesc(
        'Auto = re-index on startup + on note save. Manual = only when you click "Build Index".',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('auto', 'Auto on save')
          .addOption('manual', 'Manual only')
          .setValue(this.plugin.settings.indexingMode)
          .onChange(async (value) => {
            this.plugin.settings.indexingMode = value as 'auto' | 'manual';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName('Top-K chunks')
      .setDesc('How many vault chunks to retrieve per query (1–100).')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.retrievalK))
          .onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n) && n >= 1 && n <= 100) {
              this.plugin.settings.retrievalK = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  private renderBudgetSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Budget' });

    new Setting(parent)
      .setName('Max tokens / day')
      .setDesc('Hard cap. Reset at midnight in the timezone below.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxTokensPerDay))
          .onChange(async (value) => {
            const n = Number.parseInt(value.replace(/[,_]/g, ''), 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxTokensPerDay = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(parent)
      .setName('Max dollars / day')
      .setDesc('Hard cap on estimated USD spend.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxDollarsPerDay))
          .onChange(async (value) => {
            const n = Number.parseFloat(value);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.maxDollarsPerDay = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(parent)
      .setName('Reset timezone')
      .setDesc('IANA timezone, e.g. America/Los_Angeles or UTC.')
      .addText((text) =>
        text
          .setPlaceholder('America/Los_Angeles')
          .setValue(this.plugin.settings.budgetResetTimezone)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
              this.plugin.settings.budgetResetTimezone = trimmed;
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  private renderLogSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Conversation log' });

    new Setting(parent)
      .setName('Save conversations to vault')
      .setDesc('Every chat session writes to a markdown file under the path below.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.conversationLogEnabled)
          .onChange(async (value) => {
            this.plugin.settings.conversationLogEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName('Conversations folder')
      .setDesc('Vault-relative folder for session markdown files.')
      .addText((text) =>
        text
          .setPlaceholder('70-Memory/conversations')
          .setValue(this.plugin.settings.conversationLogPath)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed.length > 0) {
              this.plugin.settings.conversationLogPath = trimmed;
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  private renderVoyageSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Voyage embeddings (opt-in, v0.2)' });
    parent.createEl('p', {
      text:
        'Voyage AI provides higher-quality embeddings than the local model at the cost of ' +
        'sending vault chunks to a third-party API. Disabled in v0.1 — settings here are ' +
        'placeholders for the v0.2 cutover.',
      cls: 'setting-item-description',
    });

    new Setting(parent)
      .setName('Enable Voyage')
      .addToggle((toggle) => {
        toggle.setDisabled(true);
        toggle.setValue(this.plugin.settings.embeddingProvider === 'voyage');
      });

    new Setting(parent)
      .setName('Voyage API key')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setDisabled(true);
        text
          .setPlaceholder('(disabled in v0.1)')
          .setValue(this.plugin.settings.voyageApiKey);
      });
  }
}
