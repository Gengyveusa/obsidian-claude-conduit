import { Notice, Plugin } from 'obsidian';

const PLUGIN_NAME = 'Sagittarius — Claude Conduit';
const RIBBON_ICON = 'message-square';

/**
 * Sagittarius plugin entry point.
 *
 * v0.1 / Phase 2 scaffold: registers a ribbon icon and handles plugin lifecycle.
 * Side panel, settings tab, agent loop, retrieval, and tools land in Phase 3
 * per docs/02_SPEC.md and docs/2026-05-04-sagittarius-build-process.md.
 *
 * @example
 *   // Loaded automatically by Obsidian when the plugin is enabled.
 */
export default class SagittariusPlugin extends Plugin {
  override onload(): void {
    this.addRibbonIcon(RIBBON_ICON, PLUGIN_NAME, () => {
      new Notice('Sagittarius online. Side panel coming in Phase 3.');
    });

    console.warn(`[sagittarius] ${PLUGIN_NAME} v${this.manifest.version} loaded (scaffold).`);
  }

  override onunload(): void {
    console.warn(`[sagittarius] ${PLUGIN_NAME} unloaded.`);
  }
}
