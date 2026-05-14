import { beforeEach, describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { LiveMemoryProvider } from '../../src/memory/LiveMemoryProvider';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    return v === undefined
      ? Promise.reject(new Error(`ENOENT: ${path}`))
      : Promise.resolve(v);
  }
  write(): Promise<void> {
    throw new Error('unused');
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(): Promise<void> {
    throw new Error('unused');
  }
  delete(): Promise<void> {
    throw new Error('unused');
  }
  renameFile(): Promise<void> {
    throw new Error('unused');
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
}

function makeApp(activePath: string | null): App {
  const activeFile: TFile | null =
    activePath === null ? null : ({ path: activePath } as TFile);
  return {
    workspace: {
      getActiveFile: () => activeFile,
    },
  } as unknown as App;
}

describe('LiveMemoryProvider', () => {
  let adapter: MemAdapter;
  let enabled: boolean;
  let maxBytes: number;

  beforeEach(() => {
    adapter = new MemAdapter();
    enabled = true;
    maxBytes = 50_000;
  });

  function makeProvider(activePath: string | null): LiveMemoryProvider {
    return new LiveMemoryProvider({
      adapter,
      app: makeApp(activePath),
      getEnabled: () => enabled,
      getMaxBytes: () => maxBytes,
    });
  }

  it('returns null and clears lastResult when disabled', async () => {
    adapter.files.set('CLAUDE.md', 'rules');
    enabled = false;
    const provider = makeProvider(null);
    expect(await provider.collect()).toBeNull();
    expect(provider.lastResult).toBeNull();
  });

  it('returns formatted memory text when cascade has files', async () => {
    adapter.files.set('CLAUDE.md', 'root rules');
    const provider = makeProvider(null);
    const text = await provider.collect();
    expect(text).toBe('# Memory: CLAUDE.md\n\nroot rules');
    expect(provider.lastResult?.sections).toHaveLength(1);
  });

  it('returns null when cascade matches no existing files', async () => {
    const provider = makeProvider('30-Projects/foo.md');
    const text = await provider.collect();
    expect(text).toBeNull();
    expect(provider.lastResult?.sections).toEqual([]);
  });

  it('uses the workspace active file for the cascade anchor', async () => {
    adapter.files.set('CLAUDE.md', 'root');
    adapter.files.set('30-Projects/CLAUDE.md', 'project');
    const provider = makeProvider('30-Projects/foo.md');
    const text = await provider.collect();
    expect(text).toContain('# Memory: CLAUDE.md');
    expect(text).toContain('# Memory: 30-Projects/CLAUDE.md');
  });

  it('persists the latest cascade in lastResult for UI surfaces', async () => {
    adapter.files.set('CLAUDE.md', 'r');
    const provider = makeProvider(null);
    await provider.collect();
    expect(provider.lastResult?.totalBytes).toBe(1);
    // After a second collect with a new file added, lastResult updates.
    adapter.files.set('CLAUDE.md', 'rrrrr');
    await provider.collect();
    expect(provider.lastResult?.totalBytes).toBe(5);
  });

  it('preview() does NOT update lastResult', async () => {
    adapter.files.set('CLAUDE.md', 'rules');
    const provider = makeProvider(null);
    expect(provider.lastResult).toBeNull();
    const result = await provider.preview();
    expect(result.sections).toHaveLength(1);
    expect(provider.lastResult).toBeNull();
  });

  it('preview() returns empty when disabled (without polluting state)', async () => {
    adapter.files.set('CLAUDE.md', 'rules');
    enabled = false;
    const provider = makeProvider(null);
    const result = await provider.preview();
    expect(result.sections).toEqual([]);
    expect(result.budgetHit).toBe(false);
  });

  it('reads getEnabled + getMaxBytes per call so settings flips take effect', async () => {
    adapter.files.set('CLAUDE.md', 'x'.repeat(100));
    const provider = makeProvider(null);
    // First call — small budget truncates.
    maxBytes = 30;
    const truncated = await provider.collect();
    expect(provider.lastResult?.budgetHit).toBe(true);
    expect(truncated).toContain('truncated for memory budget');
    // Bump budget, call again — same file, full content.
    maxBytes = 50_000;
    const full = await provider.collect();
    expect(provider.lastResult?.budgetHit).toBe(false);
    expect(full).not.toContain('truncated for memory budget');
  });
});
