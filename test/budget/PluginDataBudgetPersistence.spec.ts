import { describe, expect, it } from 'vitest';

import { PluginDataBudgetPersistence } from '../../src/budget/PluginDataBudgetPersistence';
import type { BudgetState } from '../../src/budget/BudgetTracker';

class FakePlugin {
  data: Record<string, unknown> | null;

  constructor(initial: Record<string, unknown> | null = null) {
    this.data = initial;
  }

  loadData(): Promise<Record<string, unknown> | null> {
    return Promise.resolve(this.data);
  }

  saveData(value: Record<string, unknown>): Promise<void> {
    this.data = value;
    return Promise.resolve();
  }
}

const sampleState: BudgetState = {
  day: '2026-05-04',
  tokens_input: 1000,
  tokens_output: 500,
  dollars_estimated: 0.012,
  tz: 'America/Los_Angeles',
};

describe('PluginDataBudgetPersistence', () => {
  it('returns null when plugin data is empty', async () => {
    const plugin = new FakePlugin(null);
    const persistence = new PluginDataBudgetPersistence(plugin as never);
    expect(await persistence.load()).toBeNull();
  });

  it('returns null when no __budget key is present', async () => {
    const plugin = new FakePlugin({ apiKey: 'sk-...' });
    const persistence = new PluginDataBudgetPersistence(plugin as never);
    expect(await persistence.load()).toBeNull();
  });

  it('round-trips state through save and load', async () => {
    const plugin = new FakePlugin(null);
    const persistence = new PluginDataBudgetPersistence(plugin as never);
    await persistence.save(sampleState);
    const loaded = await persistence.load();
    expect(loaded).toEqual(sampleState);
  });

  it('preserves other plugin-data keys when saving budget', async () => {
    const plugin = new FakePlugin({ apiKey: 'sk-...', defaultModel: 'claude-sonnet-4-6' });
    const persistence = new PluginDataBudgetPersistence(plugin as never);
    await persistence.save(sampleState);
    expect(plugin.data).toEqual({
      apiKey: 'sk-...',
      defaultModel: 'claude-sonnet-4-6',
      __budget: sampleState,
    });
  });

  it('overwrites previous budget on subsequent save', async () => {
    const plugin = new FakePlugin(null);
    const persistence = new PluginDataBudgetPersistence(plugin as never);
    await persistence.save(sampleState);
    const next: BudgetState = { ...sampleState, tokens_input: 9999 };
    await persistence.save(next);
    expect(await persistence.load()).toEqual(next);
  });
});
