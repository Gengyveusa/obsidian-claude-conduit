import { Notice, Plugin } from 'obsidian';

import { openSqliteEngine } from './retrieval/openEngine';
import { SagittariusSettingTab } from './settings/SagittariusSettingTab';
import { DEFAULT_SETTINGS, type SagittariusSettings } from './settings/types';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';

/**
 * Sagittarius plugin entry point.
 *
 * v0.1 / Phase 3e-3a: settings tab + persistence are wired. ChatView,
 * QuickQuestionModal, and the ConduitAgent integration land in 3e-3b
 * per docs/02_SPEC.md and docs/2026-05-04-sagittarius-build-process.md.
 *
 * @example
 *   // Loaded automatically by Obsidian when the plugin is enabled.
 */
export default class SagittariusPlugin extends Plugin {
  settings: SagittariusSettings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SagittariusSettingTab(this.app, this));

    this.addRibbonIcon(RIBBON_ICON, PLUGIN_NAME, () => {
      new Notice('Sagittarius online. Side panel coming in Phase 3e-3b.');
    });

    // Smoke-check: open an in-memory SQLite engine on plugin load. Catches
    // wasm-load + schema-migration breakage early; cheap (<50ms).
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
      new Notice(
        `Sagittarius: SQLite engine failed to initialize. Check the developer console.`,
      );
    }
  }

  override onunload(): void {
    console.warn(`[sagittarius] ${PLUGIN_NAME} unloaded.`);
  }

  /**
   * Load persisted settings from <plugin-dir>/data.json, falling back to
   * DEFAULT_SETTINGS for any missing fields. Forward-compatible: a future
   * plugin that adds a new field reads safely from older data.json files.
   * @example await this.loadSettings();
   */
  async loadSettings(): Promise<void> {
    const persisted = (await this.loadData()) as Partial<SagittariusSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(persisted ?? {}) };
  }

  /**
   * Persist the current settings object. Called by SagittariusSettingTab
   * after every onChange.
   * @example await this.saveSettings();
   */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
