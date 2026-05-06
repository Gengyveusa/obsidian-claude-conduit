import { Notice, Plugin } from 'obsidian';
import { openSqliteEngine } from './retrieval/openEngine';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';

/**
 * Sagittarius plugin entry point.
 *
 * v0.1 / Phase 3b scaffold: registers a ribbon icon, smoke-loads the SQLite
 * engine on startup to verify the bundled sql.js wasm + esbuild binary
 * loader path are intact (per ADR-011). Side panel, settings tab, agent
 * loop, retrieval, and tools land in Phase 3c+ per docs/02_SPEC.md.
 *
 * @example
 *   // Loaded automatically by Obsidian when the plugin is enabled.
 */
export default class SagittariusPlugin extends Plugin {
  override async onload(): Promise<void> {
    this.addRibbonIcon(RIBBON_ICON, PLUGIN_NAME, () => {
      new Notice('Sagittarius online. Side panel coming in Phase 3c.');
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
}
