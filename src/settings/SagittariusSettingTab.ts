import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';

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
    this.renderEmbeddingsSection(containerEl);
    this.renderRetrievalSection(containerEl);
    this.renderBudgetSection(containerEl);
    this.renderLogSection(containerEl);
    this.renderWriteLayerSection(containerEl);
    this.renderOrganizationSection(containerEl);
    this.renderVoyageSection(containerEl);
  }

  private renderOrganizationSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Organization (Phase 5)' });
    parent.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Proactive: Sagittarius watches selected folders for new notes and proposes ' +
        'better folders for them in a Suggestions panel. Off by default — flip the switch below to opt in. ' +
        'Per ADR-017.',
    });

    new Setting(parent)
      .setName('Enable organization engine')
      .setDesc(
        'When on, vault events trigger the classifier and queue suggestions. Off = no events, no classifier calls.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.organizationEnabled).onChange(async (value) => {
          this.plugin.settings.organizationEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshOrganizationEngine();
        }),
      );

    new Setting(parent)
      .setName('Watched folders')
      .setDesc(
        'Comma-separated vault-relative folders (e.g. "10-Inbox/, 11-Drafts/"). Only notes in these folders get classified.',
      )
      .addText((text) =>
        text
          .setPlaceholder('10-Inbox/')
          .setValue(this.plugin.settings.organizationWatchedFolders.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.organizationWatchedFolders = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.refreshOrganizationEngine();
          }),
      );

    new Setting(parent)
      .setName('Classifier model')
      .setDesc(
        'Sonnet (default) is the recommended balance per ADR-017 D4. Haiku is cheaper but routes more noisily; Opus costs more but reasons better about subtle conventions.',
      )
      .addDropdown((dd) =>
        dd
          .addOption('claude-sonnet-4-6', 'Sonnet 4.6 (recommended)')
          .addOption('claude-haiku-4-5-20251001', 'Haiku 4.5 (cheap)')
          .addOption('claude-opus-4-7', 'Opus 4.7 (premium)')
          .setValue(this.plugin.settings.organizationClassifierModel)
          .onChange(async (value) => {
            this.plugin.settings.organizationClassifierModel =
              value as typeof this.plugin.settings.organizationClassifierModel;
            await this.plugin.saveSettings();
            this.plugin.refreshOrganizationEngine();
          }),
      );

    new Setting(parent)
      .setName('Minimum confidence')
      .setDesc(
        'Suggestions below this confidence are stored on disk but hidden by default. Range 0–1; default 0.6.',
      )
      .addText((text) =>
        text
          .setPlaceholder('0.6')
          .setValue(String(this.plugin.settings.organizationMinConfidence))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === '') {
              return;
            }
            const n = parseFloat(trimmed);
            if (!Number.isFinite(n) || n < 0 || n > 1) {
              new Notice('Sagittarius: minimum confidence must be a number between 0 and 1.');
              return;
            }
            this.plugin.settings.organizationMinConfidence = n;
            await this.plugin.saveSettings();
            this.plugin.refreshOrganizationEngine();
          }),
      );

    new Setting(parent)
      .setName('Background sweep interval')
      .setDesc(
        'Periodically re-scan watched folders, in seconds. 0 (default) = manual only — sweep runs only when you trigger “Sagittarius: organize inbox now.” Non-zero schedules a silent periodic sweep; a toast appears only if it surfaces a new suggestion.',
      )
      .addText((text) =>
        text
          .setPlaceholder('0')
          .setValue(String(this.plugin.settings.organizationSweepIntervalSec))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed === '') {
              return;
            }
            const n = parseInt(trimmed, 10);
            if (!Number.isFinite(n) || n < 0 || String(n) !== trimmed) {
              new Notice('Sagittarius: sweep interval must be a non-negative integer (seconds).');
              return;
            }
            this.plugin.settings.organizationSweepIntervalSec = n;
            await this.plugin.saveSettings();
            this.plugin.refreshOrganizationEngine();
          }),
      );

    new Setting(parent)
      .setName('MOC folders (v0.6.x)')
      .setDesc(
        'Comma-separated folders where Map-of-Content notes live (e.g. "22-Decisions/, 30-Gengyve-GTM/"). When non-empty, Sagittarius proposes adding inbox notes to a matching MOC via `link_notes` (still gated by the diff card). Empty = moc-add disabled.',
      )
      .addText((text) =>
        text
          .setPlaceholder('22-Decisions/')
          .setValue(this.plugin.settings.organizationMocFolders.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.organizationMocFolders = value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.refreshOrganizationEngine();
          }),
      );
  }

  private renderWriteLayerSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Write layer (Phase 4)' });
    parent.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Controls how the 9 write tools (`create_note`, `patch_note`, `move_note`, etc.) apply changes. ' +
        'In review mode every proposal routes through a diff card you have to Confirm. ' +
        '`auto` is reserved for a future release after Phase 4 has been battle-tested.',
    });

    new Setting(parent)
      .setName('Write mode')
      .setDesc(
        'review = diff-first, manual approval per tool call. auto = apply immediately (not wired in v0.5; behaves as review).',
      )
      .addDropdown((dd) =>
        dd
          .addOption('review', 'Review (diff card, manual confirm)')
          .addOption('auto', 'Auto (disabled in v0.5 — behaves as review)')
          .setValue(this.plugin.settings.writeMode)
          .onChange(async (value) => {
            this.plugin.settings.writeMode =
              value === 'auto' ? 'auto' : 'review';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName('Default attachments folder')
      .setDesc(
        'Where `file_asset` writes binaries when the agent does not specify a folder. ' +
          'Vault-relative; defaults to "attachments". Match your Obsidian "Files & Links → Attachment folder path" if you changed it.',
      )
      .addText((text) =>
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.defaultAttachmentsFolder)
          .onChange(async (value) => {
            this.plugin.settings.defaultAttachmentsFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );
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

  private renderEmbeddingsSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: 'Embeddings (HuggingFace Inference API)' });
    parent.createEl('p', {
      cls: 'setting-item-description',
      text:
        "Enables search_vault + Vault QA mode. v0.2 routes embeddings through HuggingFace's Inference API per ADR-013. Free read-token from huggingface.co/settings/tokens. Without a token, chat-mode + 4 vault-API tools still work — just no semantic search.",
    });

    new Setting(parent)
      .setName('HuggingFace API key')
      .setDesc(
        'Stored in this plugin\'s data directory; never sent anywhere except api-inference.huggingface.co. ' +
          'Make sure your vault gitignores .obsidian/plugins/obsidian-claude-conduit/data.json.',
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('hf_...')
          .setValue(this.plugin.settings.huggingfaceApiKey)
          .onChange(async (value) => {
            this.plugin.settings.huggingfaceApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });
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
