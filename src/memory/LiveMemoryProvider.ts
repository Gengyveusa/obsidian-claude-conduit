import type { App } from 'obsidian';

import type { VaultAdapter } from '../agent/types';
import type { MemoryProvider } from '../agent/ConduitAgent';

import {
  collectMemory,
  formatMemoryPromptText,
  type CascadeResult,
} from './MemoryCascade';

/**
 * Phase 9 (v1.3.0) — plugin-side `MemoryProvider` implementation
 * per ADR-029.
 *
 * Resolves the cascade fresh on every chat turn (D6) by reading
 * the current `workspace.getActiveFile()` path. Caches the latest
 * `CascadeResult` so the status bar pill + chat footer can render
 * the same view that the agent saw on the last turn (D7).
 *
 * Construction is cheap (no I/O). The first `collect()` is the
 * first cascade read. Errors during read propagate to the caller
 * (`ConduitAgent.chat()` catches and degrades to "no memory").
 *
 * Toggled off via the `getEnabled` accessor — when false, `collect`
 * returns `null` immediately and `lastResult` is cleared so the
 * status bar pill reflects the off state.
 */
export interface LiveMemoryProviderDeps {
  adapter: VaultAdapter;
  /** Obsidian `App` — accessed for `workspace.getActiveFile()`. */
  app: App;
  /** Live accessor — read each turn so settings flips take effect. */
  getEnabled: () => boolean;
  /** Live accessor — read each turn for the same reason. */
  getMaxBytes: () => number;
}

export class LiveMemoryProvider implements MemoryProvider {
  private readonly deps: LiveMemoryProviderDeps;
  private latest: CascadeResult | null = null;

  constructor(deps: LiveMemoryProviderDeps) {
    this.deps = deps;
  }

  async collect(): Promise<string | null> {
    if (!this.deps.getEnabled()) {
      this.latest = null;
      return null;
    }
    const result = await collectMemory({
      adapter: this.deps.adapter,
      activeFilePath: this.activeFilePath(),
      maxBytes: this.deps.getMaxBytes(),
    });
    this.latest = result;
    return formatMemoryPromptText(result.sections);
  }

  /**
   * Run a cascade now WITHOUT updating `lastResult` — used by the
   * status bar pill modal to render the "what would load if I sent
   * a message now?" preview. Separate from `collect()` because the
   * modal shouldn't pollute the lastResult that ChatView's footer
   * reflects.
   */
  async preview(): Promise<CascadeResult> {
    if (!this.deps.getEnabled()) {
      return { sections: [], totalBytes: 0, budgetHit: false };
    }
    return collectMemory({
      adapter: this.deps.adapter,
      activeFilePath: this.activeFilePath(),
      maxBytes: this.deps.getMaxBytes(),
    });
  }

  /** Snapshot of the most recent `collect()` result — for status bar / footer. */
  get lastResult(): CascadeResult | null {
    return this.latest;
  }

  private activeFilePath(): string | null {
    const file = this.deps.app.workspace.getActiveFile();
    return file === null ? null : file.path;
  }
}
