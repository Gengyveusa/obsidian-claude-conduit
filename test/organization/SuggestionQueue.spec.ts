import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { JsonSuggestionQueue } from '../../src/organization/SuggestionQueue';
import type { RouteSuggestion, Suggestion } from '../../src/organization/types';

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

const QUEUE_PATH = '.obsidian/plugins/obsidian-claude-conduit/suggestions.json';

function makeRoute(over: Partial<RouteSuggestion> = {}): RouteSuggestion {
  return {
    kind: 'route',
    id: '1700000000000-aaaaaa',
    createdAt: 1700000000,
    notePath: '10-Inbox/foo.md',
    proposedFolder: '70-Memory/notes',
    reason: 'Similar to 4 of 5 nearby notes.',
    confidence: 0.8,
    ...over,
  };
}

describe('JsonSuggestionQueue', () => {
  let adapter: MemAdapter;
  let queue: JsonSuggestionQueue;

  beforeEach(() => {
    adapter = new MemAdapter();
    queue = new JsonSuggestionQueue({ adapter, path: QUEUE_PATH });
  });

  describe('add', () => {
    it('persists a new suggestion as JSON', async () => {
      const added = await queue.add(makeRoute());
      expect(added).toBe(true);

      const raw = adapter.files.get(QUEUE_PATH);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!) as Suggestion[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].notePath).toBe('10-Inbox/foo.md');
    });

    it('dedups by notePath: returns false and does not persist again', async () => {
      await queue.add(makeRoute({ id: '1', notePath: '10-Inbox/dup.md' }));
      const second = await queue.add(makeRoute({ id: '2', notePath: '10-Inbox/dup.md' }));

      expect(second).toBe(false);
      const all = await queue.list();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('1');
    });

    it('caps the queue at maxEntries (FIFO truncation)', async () => {
      const small = new JsonSuggestionQueue({ adapter, path: QUEUE_PATH, maxEntries: 3 });
      for (let i = 0; i < 5; i++) {
        await small.add(makeRoute({ id: `${i}`, notePath: `10-Inbox/n${i}.md`, createdAt: 1700000000 + i }));
      }
      const all = await small.list();
      expect(all).toHaveLength(3);
      expect(all.map((s) => s.notePath)).toEqual([
        // Newest non-deferred first; only the last 3 are kept (n2, n3, n4)
        '10-Inbox/n4.md',
        '10-Inbox/n3.md',
        '10-Inbox/n2.md',
      ]);
    });
  });

  describe('list', () => {
    it('returns [] for an empty queue', async () => {
      expect(await queue.list()).toEqual([]);
    });

    it('sorts non-deferred newest-first, deferred at the bottom', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md', createdAt: 1, deferred: false }));
      await queue.add(makeRoute({ id: '2', notePath: 'b.md', createdAt: 3, deferred: true }));
      await queue.add(makeRoute({ id: '3', notePath: 'c.md', createdAt: 2, deferred: false }));
      await queue.add(makeRoute({ id: '4', notePath: 'd.md', createdAt: 4, deferred: true }));

      const ordered = await queue.list();
      expect(ordered.map((s) => s.id)).toEqual(['3', '1', '4', '2']);
    });

    it('drops deferred entries when includeDeferred=false', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md', deferred: true }));
      await queue.add(makeRoute({ id: '2', notePath: 'b.md', deferred: false }));

      const visible = await queue.list({ includeDeferred: false });
      expect(visible.map((s) => s.id)).toEqual(['2']);
    });

    it('filters by minConfidence', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md', confidence: 0.4 }));
      await queue.add(makeRoute({ id: '2', notePath: 'b.md', confidence: 0.7 }));
      await queue.add(makeRoute({ id: '3', notePath: 'c.md', confidence: 0.9 }));

      const high = await queue.list({ minConfidence: 0.6 });
      expect(high.map((s) => s.id).sort()).toEqual(['2', '3']);
    });
  });

  describe('remove', () => {
    it('removes by id and returns the entry', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md' }));
      await queue.add(makeRoute({ id: '2', notePath: 'b.md' }));

      const removed = await queue.remove('1');
      expect(removed?.notePath).toBe('a.md');
      const remaining = await queue.list();
      expect(remaining.map((s) => s.id)).toEqual(['2']);
    });

    it('returns null for a missing id, no-op on disk', async () => {
      await queue.add(makeRoute());
      const result = await queue.remove('does-not-exist');
      expect(result).toBeNull();
      expect(await queue.size()).toBe(1);
    });
  });

  describe('defer', () => {
    it('marks an entry as deferred and returns the updated suggestion', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md', createdAt: 5 }));
      await queue.add(makeRoute({ id: '2', notePath: 'b.md', createdAt: 10 }));

      const deferred = await queue.defer('2');
      expect(deferred?.deferred).toBe(true);

      // After defer, '2' (now deferred) sorts to the bottom even though it's newer
      const ordered = await queue.list();
      expect(ordered.map((s) => s.id)).toEqual(['1', '2']);
    });

    it('returns null for a missing id', async () => {
      expect(await queue.defer('nope')).toBeNull();
    });

    it('is idempotent — defer-on-deferred is a no-op', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md', deferred: true }));
      const result = await queue.defer('1');
      expect(result?.deferred).toBe(true);
      const all = await queue.list();
      expect(all).toHaveLength(1);
    });
  });

  describe('hasForNote', () => {
    it('returns false on empty queue', async () => {
      expect(await queue.hasForNote('a.md')).toBe(false);
    });

    it('returns true when a suggestion exists for the path', async () => {
      await queue.add(makeRoute({ notePath: '10-Inbox/here.md' }));
      expect(await queue.hasForNote('10-Inbox/here.md')).toBe(true);
      expect(await queue.hasForNote('10-Inbox/elsewhere.md')).toBe(false);
    });
  });

  describe('clear + size', () => {
    it('size reports total including deferred', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'a.md', deferred: false }));
      await queue.add(makeRoute({ id: '2', notePath: 'b.md', deferred: true }));
      expect(await queue.size()).toBe(2);
    });

    it('clear empties the queue and persists []', async () => {
      await queue.add(makeRoute());
      await queue.clear();
      expect(await queue.size()).toBe(0);
      expect(adapter.files.get(QUEUE_PATH)).toBe('[]');
    });
  });

  describe('persistence round-trip', () => {
    it('a fresh queue instance against the same adapter sees prior entries', async () => {
      await queue.add(makeRoute({ id: '1', notePath: 'persisted.md' }));

      // Simulate plugin reload — same disk, new queue instance.
      const fresh = new JsonSuggestionQueue({ adapter, path: QUEUE_PATH });
      const all = await fresh.list();
      expect(all).toHaveLength(1);
      expect(all[0].notePath).toBe('persisted.md');
    });

    it('returns [] when the file is empty whitespace', async () => {
      adapter.files.set(QUEUE_PATH, '   \n');
      expect(await queue.list()).toEqual([]);
    });

    it('throws a clear error on non-array JSON', async () => {
      adapter.files.set(QUEUE_PATH, JSON.stringify({ wrong: 'shape' }));
      await expect(queue.list()).rejects.toThrow(/non-array JSON/);
    });
  });

  describe('moc-add suggestions round-trip', () => {
    it('persists and reads back a moc-add suggestion with its mocPath + mocAnchor', async () => {
      const moc: Suggestion = {
        kind: 'moc-add',
        id: 'moc-1',
        createdAt: 100,
        notePath: '10-Inbox/topic.md',
        mocPath: '22-Decisions/00_Index.md',
        mocAnchor: '## Recent',
        reason: 'Topic clusters with other Decisions.',
        confidence: 0.75,
      };
      await queue.add(moc);
      const all = await queue.list();
      expect(all).toEqual([moc]);
    });
  });
});
