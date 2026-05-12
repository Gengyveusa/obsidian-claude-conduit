import { describe, expect, it } from 'vitest';

import { JsonActivityLog } from '../../src/activity/ActivityLog';
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

const LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/activity.json';

interface ClockState {
  now: number;
  suffix: number;
}

function makeLog(maxEntries = 1000): { log: JsonActivityLog; adapter: MemAdapter; clock: ClockState } {
  const adapter = new MemAdapter();
  const clock: ClockState = { now: 1_700_000_000_000, suffix: 0 };
  const log = new JsonActivityLog({
    adapter,
    path: LOG_PATH,
    maxEntries,
    now: () => clock.now,
    randomSuffix: () => {
      clock.suffix += 1;
      return clock.suffix.toString(36).padStart(6, '0');
    },
  });
  return { log, adapter, clock };
}

describe('JsonActivityLog', () => {
  it('records events with auto-populated id + timestamp', async () => {
    const { log, clock } = makeLog();
    clock.now = 1_700_000_001_000;
    const event = await log.record({
      kind: 'classifier.ran',
      notePath: '10-Inbox/foo.md',
      model: 'claude-sonnet-4-6',
      outcome: 'route',
      confidence: 0.9,
      durationMs: 800,
    });
    expect(event.id).toMatch(/^1700000001000-/);
    expect(event.timestamp).toBe(1_700_000_001_000);
    expect(event.kind).toBe('classifier.ran');
    if (event.kind === 'classifier.ran') {
      expect(event.confidence).toBe(0.9);
    }
  });

  it('persists across instances', async () => {
    const adapter = new MemAdapter();
    const log1 = new JsonActivityLog({ adapter, path: LOG_PATH });
    await log1.record({ kind: 'error', source: 'watcher', message: 'boom' });
    const log2 = new JsonActivityLog({ adapter, path: LOG_PATH });
    const list = await log2.list();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('error');
  });

  it('returns events newest-first by timestamp', async () => {
    const { log, clock } = makeLog();
    clock.now = 1000;
    await log.record({ kind: 'error', source: 'a', message: 'first' });
    clock.now = 3000;
    await log.record({ kind: 'error', source: 'c', message: 'third' });
    clock.now = 2000;
    await log.record({ kind: 'error', source: 'b', message: 'second' });
    const list = await log.list();
    expect(list.map((e) => (e as { message: string }).message)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('filters by kind', async () => {
    const { log, clock } = makeLog();
    clock.now = 1000;
    await log.record({ kind: 'error', source: 'x', message: 'boom' });
    clock.now = 2000;
    await log.record({
      kind: 'write.committed',
      toolName: 'create_note',
      path: 'foo.md',
    });
    clock.now = 3000;
    await log.record({ kind: 'error', source: 'y', message: 'pow' });
    const errors = await log.list({ kinds: ['error'] });
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.kind === 'error')).toBe(true);
  });

  it('filters by sinceMs', async () => {
    const { log, clock } = makeLog();
    clock.now = 1000;
    await log.record({ kind: 'error', source: 'old', message: 'old' });
    clock.now = 5000;
    await log.record({ kind: 'error', source: 'mid', message: 'mid' });
    clock.now = 9000;
    await log.record({ kind: 'error', source: 'new', message: 'new' });
    const recent = await log.list({ sinceMs: 4000 });
    expect(recent.map((e) => (e as { message: string }).message)).toEqual(['new', 'mid']);
  });

  it('respects limit', async () => {
    const { log, clock } = makeLog();
    for (let i = 0; i < 10; i += 1) {
      clock.now = 1000 + i;
      await log.record({ kind: 'error', source: 's', message: `m${i}` });
    }
    const list = await log.list({ limit: 3 });
    expect(list).toHaveLength(3);
    expect((list[0] as { message: string }).message).toBe('m9');
  });

  it('enforces the rolling cap', async () => {
    const { log, clock } = makeLog(5);
    for (let i = 0; i < 8; i += 1) {
      clock.now = 1000 + i;
      await log.record({ kind: 'error', source: 's', message: `m${i}` });
    }
    const list = await log.list();
    expect(list).toHaveLength(5);
    // Oldest three (m0..m2) should have fallen off; newest = m7.
    expect((list[0] as { message: string }).message).toBe('m7');
    expect((list[4] as { message: string }).message).toBe('m3');
  });

  it('size reflects current entry count', async () => {
    const { log, clock } = makeLog(3);
    expect(await log.size()).toBe(0);
    for (let i = 0; i < 5; i += 1) {
      clock.now = 1000 + i;
      await log.record({ kind: 'error', source: 's', message: `m${i}` });
    }
    expect(await log.size()).toBe(3);
  });

  it('clear() drops every event', async () => {
    const { log } = makeLog();
    await log.record({ kind: 'error', source: 's', message: 'x' });
    await log.clear();
    expect(await log.size()).toBe(0);
  });

  it('tolerates a missing file (first-run case)', async () => {
    const { log } = makeLog();
    const list = await log.list();
    expect(list).toEqual([]);
  });

  it('throws actionable error on non-array JSON', async () => {
    const adapter = new MemAdapter();
    adapter.files.set(LOG_PATH, '{"not": "an array"}');
    const log = new JsonActivityLog({ adapter, path: LOG_PATH });
    await expect(log.list()).rejects.toThrow(/non-array JSON/);
  });

  it('records all 9 event kinds without type errors', async () => {
    const { log } = makeLog();
    await log.record({
      kind: 'index.built',
      notesProcessed: 1,
      chunksAdded: 1,
      chunksSkipped: 0,
      durationMs: 100,
    });
    await log.record({
      kind: 'classifier.ran',
      notePath: 'a.md',
      model: 'claude-sonnet-4-6',
      outcome: 'keep',
      durationMs: 100,
    });
    await log.record({
      kind: 'suggestion.enqueued',
      suggestionId: 's1',
      suggestionKind: 'route',
      notePath: 'a.md',
      target: 'archive',
      confidence: 0.8,
    });
    await log.record({
      kind: 'suggestion.applied',
      suggestionId: 's1',
      suggestionKind: 'route',
      notePath: 'a.md',
      writeToolName: 'move_note',
    });
    await log.record({
      kind: 'suggestion.rejected',
      suggestionId: 's2',
      notePath: 'b.md',
    });
    await log.record({
      kind: 'suggestion.skipped',
      suggestionId: 's3',
      notePath: 'c.md',
      bulk: false,
    });
    await log.record({ kind: 'write.committed', toolName: 'create_note', path: 'd.md' });
    await log.record({ kind: 'write.undone', transactionId: 'tx-1' });
    await log.record({ kind: 'error', source: 'watcher', message: 'kaboom' });
    expect(await log.size()).toBe(9);
  });
});
