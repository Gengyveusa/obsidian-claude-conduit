import { describe, expect, it } from 'vitest';

import { JsonSkipPatternStore } from '../../src/curator/SkipPatternStore';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();

  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const v = this.files.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
  }
  write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
    return Promise.resolve();
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
    return Promise.resolve([]);
  }
}

const PATH = '.obsidian/plugins/obsidian-claude-conduit/curator-skip-patterns.json';

function newStore(): { store: JsonSkipPatternStore; adapter: MemAdapter } {
  const adapter = new MemAdapter();
  const store = new JsonSkipPatternStore({ adapter, path: PATH });
  return { store, adapter };
}

describe('JsonSkipPatternStore', () => {
  it('matches nothing when empty', async () => {
    const { store } = newStore();
    expect(await store.matches('add-frontmatter', '10-Inbox/a.md')).toBe(false);
    expect(await store.signatures()).toEqual([]);
  });

  it('records and exact-matches a single signature', async () => {
    const { store } = newStore();
    await store.record('add-frontmatter', '10-Inbox/a.md');
    expect(await store.matches('add-frontmatter', '10-Inbox/a.md')).toBe(true);
    expect(await store.matches('add-frontmatter', '10-Inbox/b.md')).toBe(false);
    expect(await store.matches('archive-stale', '10-Inbox/a.md')).toBe(false);
  });

  it('treats pathPrefix as a startsWith prefix', async () => {
    const { store } = newStore();
    await store.record('archive-stale', '10-Inbox/');
    expect(await store.matches('archive-stale', '10-Inbox/a.md')).toBe(true);
    expect(await store.matches('archive-stale', '10-Inbox/sub/b.md')).toBe(true);
    expect(await store.matches('archive-stale', '20-Projects/c.md')).toBe(false);
  });

  it('dedupes exact-match record calls', async () => {
    const { store } = newStore();
    await store.record('add-frontmatter', '10-Inbox/a.md');
    await store.record('add-frontmatter', '10-Inbox/a.md');
    expect(await store.signatures()).toHaveLength(1);
  });

  it('keeps distinct kind/prefix combinations apart', async () => {
    const { store } = newStore();
    await store.record('add-frontmatter', '10-Inbox/a.md');
    await store.record('archive-stale', '10-Inbox/a.md');
    await store.record('add-frontmatter', '10-Inbox/b.md');
    const sigs = await store.signatures();
    expect(sigs).toHaveLength(3);
  });

  it('persists across instances backed by the same adapter', async () => {
    const adapter = new MemAdapter();
    const store1 = new JsonSkipPatternStore({ adapter, path: PATH });
    await store1.record('archive-stale', '10-Inbox/');

    const store2 = new JsonSkipPatternStore({ adapter, path: PATH });
    expect(await store2.matches('archive-stale', '10-Inbox/a.md')).toBe(true);
  });

  it('remove drops by index; out-of-range is a no-op', async () => {
    const { store } = newStore();
    await store.record('a', '1');
    await store.record('b', '2');
    await store.record('c', '3');
    await store.remove(1);
    expect((await store.signatures()).map((s) => s.kind)).toEqual(['a', 'c']);
    await store.remove(99);
    await store.remove(-1);
    expect(await store.signatures()).toHaveLength(2);
  });

  it('clear empties the store', async () => {
    const { store } = newStore();
    await store.record('a', '1');
    await store.record('b', '2');
    await store.clear();
    expect(await store.signatures()).toEqual([]);
    expect(await store.matches('a', '1')).toBe(false);
  });

  it('returns empty on a corrupted JSON file and rewrites it cleanly', async () => {
    const { store, adapter } = newStore();
    adapter.files.set(PATH, '{not json[');
    expect(await store.signatures()).toEqual([]);
    // Subsequent record should work.
    await store.record('a', '1');
    expect(await store.matches('a', '1')).toBe(true);
  });

  it('returns empty when the file holds a non-array', async () => {
    const { store, adapter } = newStore();
    adapter.files.set(PATH, '{"kind":"a","pathPrefix":"x"}');
    expect(await store.signatures()).toEqual([]);
  });

  it('filters out malformed entries on load', async () => {
    const { store, adapter } = newStore();
    adapter.files.set(
      PATH,
      JSON.stringify([
        { kind: 'a', pathPrefix: '1' },
        { kind: 42, pathPrefix: 'x' }, // bad kind
        { kind: 'b' }, // missing pathPrefix
        null,
        'oops',
        { kind: 'c', pathPrefix: '3' },
      ]),
    );
    const sigs = await store.signatures();
    expect(sigs).toEqual([
      { kind: 'a', pathPrefix: '1' },
      { kind: 'c', pathPrefix: '3' },
    ]);
  });
});
