import type { Plugin } from 'obsidian';

import type { BudgetPersistence, BudgetState } from './BudgetTracker';

const BUDGET_KEY = '__budget';

/**
 * BudgetPersistence backed by Obsidian's `plugin.loadData()` /
 * `saveData()`. The plugin's data.json doubles as settings store; we
 * stash budget state under a `__budget` key so it doesn't collide with
 * any settings field name.
 *
 * @example
 *   const persistence = new PluginDataBudgetPersistence(this);
 *   const tracker = await BudgetTracker.load(persistence, limits);
 */
export class PluginDataBudgetPersistence implements BudgetPersistence {
  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<BudgetState | null> {
    const raw = (await this.plugin.loadData()) as Record<string, unknown> | null;
    if (!raw || typeof raw[BUDGET_KEY] !== 'object' || raw[BUDGET_KEY] === null) {
      return null;
    }
    return raw[BUDGET_KEY] as BudgetState;
  }

  async save(state: BudgetState): Promise<void> {
    const raw = ((await this.plugin.loadData()) as Record<string, unknown> | null) ?? {};
    raw[BUDGET_KEY] = state;
    await this.plugin.saveData(raw);
  }
}
