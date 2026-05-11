import { describe, expect, it } from 'vitest';

import { IndexPersistence } from '../../src/indexing/IndexPersistence';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';

class FakeAdapter implements VaultAdapter {
  files = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  mkdirCalls: string[] = [];

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }
  read(_path: string): Promise<string> {
    return Promise.resolve('');
  }
  readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) {
      return Promise.reject(new Error(`not found: ${path}`));
    }
    return Promise.resolve(file);
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  delete(_path: string): Promise<void> {
    return Promise.resolve();
  }
  renameFile(): Promise<void> {
    throw new Error("unused");
  }
  mkdir(path: string): Promise<void> {
    this.folders.add(path);
    this.mkdirCalls.push(path);
    return Promise.resolve();
  }
  stat(_path: string): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

const PATH = '.obsidian/plugins/obsidian-claude-conduit/index.sqlite';

describe('IndexPersistence', () => {
  it('exists() returns false when no file persisted', async () => {
    const persistence = new IndexPersistence(new FakeAdapter(), PATH);
    expect(await persistence.exists()).toBe(false);
  });

  it('load() returns undefined when no file present', async () => {
    const persistence = new IndexPersistence(new FakeAdapter(), PATH);
    expect(await persistence.load()).toBeUndefined();
  });

  it('save() then load() round-trips a Uint8Array bit-exactly', async () => {
    const adapter = new FakeAdapter();
    const persistence = new IndexPersistence(adapter, PATH);
    const data = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20]);
    await persistence.save(data);
    const loaded = await persistence.load();
    expect(loaded).toBeInstanceOf(Uint8Array);
    expect(Array.from(loaded as Uint8Array)).toEqual(Array.from(data));
  });

  it('save() creates the parent folder via mkdir', async () => {
    const adapter = new FakeAdapter();
    const persistence = new IndexPersistence(adapter, PATH);
    await persistence.save(new Uint8Array(8));
    expect(adapter.mkdirCalls).toContain('.obsidian/plugins/obsidian-claude-conduit');
  });

  it('save() copies into a fresh ArrayBuffer (no SharedArrayBuffer leak)', async () => {
    const adapter = new FakeAdapter();
    const persistence = new IndexPersistence(adapter, PATH);
    const data = new Uint8Array([1, 2, 3, 4]);
    await persistence.save(data);
    // The adapter received an ArrayBuffer that's distinct from data.buffer
    const stored = adapter.files.get(PATH);
    expect(stored).not.toBe(data.buffer);
    expect(stored?.byteLength).toBe(4);
  });

  it('exists() returns true after save', async () => {
    const adapter = new FakeAdapter();
    const persistence = new IndexPersistence(adapter, PATH);
    await persistence.save(new Uint8Array(8));
    expect(await persistence.exists()).toBe(true);
  });
});
