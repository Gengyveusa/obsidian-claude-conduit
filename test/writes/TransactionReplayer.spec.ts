import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { JsonTransactionLog } from '../../src/writes/TransactionLog';
import { dispatchInverse, TransactionReplayer } from '../../src/writes/TransactionReplayer';
import type { AppliedOp, InverseOp } from '../../src/writes/types';
import { WriteToolContext } from '../../src/writes/WriteToolContext';

/**
 * In-memory `VaultAdapter` with delete support. Tracks mtime per file
 * so tests can simulate stat behavior if needed.
 */
class MemAdapter implements VaultAdapter {
  files = new Map<string, { content: string; mtime: number }>();
  /** When set, every write/delete will throw — used to simulate adapter failures. */
  failNext: { op: 'write' | 'delete'; message: string } | null = null;

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const f = this.files.get(path);
    return f === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(f.content);
  }
  write(path: string, content: string): Promise<void> {
    if (this.failNext?.op === 'write') {
      const msg = this.failNext.message;
      this.failNext = null;
      return Promise.reject(new Error(msg));
    }
    const existing = this.files.get(path);
    this.files.set(path, { content, mtime: (existing?.mtime ?? 0) + 1 });
    return Promise.resolve();
  }
  delete(path: string): Promise<void> {
    if (this.failNext?.op === 'delete') {
      const msg = this.failNext.message;
      this.failNext = null;
      return Promise.reject(new Error(msg));
    }
    if (!this.files.has(path)) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    this.files.delete(path);
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(): Promise<void> {
    throw new Error('unused');
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(path: string): Promise<VaultStat | null> {
    const f = this.files.get(path);
    return Promise.resolve(f === undefined ? null : { mtime: f.mtime, size: f.content.length });
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

const LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/transactions.json';

function makeAppliedOp(toolName: string, path: string, inverse: InverseOp): AppliedOp {
  return { toolName, path, appliedAt: 1700000000, inverse };
}

interface Harness {
  adapter: MemAdapter;
  log: JsonTransactionLog;
  ctx: WriteToolContext;
  replayer: TransactionReplayer;
}

function makeHarness(): Harness {
  const adapter = new MemAdapter();
  const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
  const ctx = new WriteToolContext(log);
  const replayer = new TransactionReplayer({ adapter, log });
  return { adapter, log, ctx, replayer };
}

describe('dispatchInverse', () => {
  it("deletes the file for 'delete-file' inverse", async () => {
    const adapter = new MemAdapter();
    adapter.files.set('foo.md', { content: 'hi', mtime: 1 });
    await dispatchInverse(adapter, { kind: 'delete-file', path: 'foo.md' });
    expect(adapter.files.has('foo.md')).toBe(false);
  });

  it("treats missing file as success for 'delete-file' (idempotent)", async () => {
    const adapter = new MemAdapter();
    await expect(
      dispatchInverse(adapter, { kind: 'delete-file', path: 'missing.md' }),
    ).resolves.toBeUndefined();
  });

  it("restores content for 'write-file' inverse, overwriting current state", async () => {
    const adapter = new MemAdapter();
    adapter.files.set('foo.md', { content: 'modified', mtime: 5 });
    await dispatchInverse(adapter, { kind: 'write-file', path: 'foo.md', content: 'original' });
    expect(adapter.files.get('foo.md')?.content).toBe('original');
  });

  it("creates the file when 'write-file' targets a missing path", async () => {
    const adapter = new MemAdapter();
    await dispatchInverse(adapter, { kind: 'write-file', path: 'recreate.md', content: 'data' });
    expect(adapter.files.get('recreate.md')?.content).toBe('data');
  });
});

describe('TransactionReplayer', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('peekLast', () => {
    it('returns null when the log is empty', async () => {
      expect(await h.replayer.peekLast()).toBeNull();
    });

    it('returns the most recent transaction without mutating the log', async () => {
      h.ctx.begin('s1');
      h.ctx.record(makeAppliedOp('create_note', 'a.md', { kind: 'delete-file', path: 'a.md' }));
      await h.ctx.end();
      h.ctx.begin('s2');
      h.ctx.record(makeAppliedOp('create_note', 'b.md', { kind: 'delete-file', path: 'b.md' }));
      await h.ctx.end();

      const tx = await h.replayer.peekLast();
      expect(tx?.sessionId).toBe('s2');
      // Log still has both
      const all = await h.log.recent();
      expect(all).toHaveLength(2);
    });
  });

  describe('undo — empty log', () => {
    it('returns transaction: null, no outcomes, removedFromLog: false', async () => {
      const result = await h.replayer.undo();
      expect(result).toEqual({
        transaction: null,
        outcomes: [],
        removedFromLog: false,
      });
    });
  });

  describe('undo — single-op transactions', () => {
    it("reverses a create_note (delete-file inverse) and removes the tx", async () => {
      h.adapter.files.set('foo.md', { content: 'created by Claude', mtime: 1 });
      h.ctx.begin();
      h.ctx.record(
        makeAppliedOp('create_note', 'foo.md', { kind: 'delete-file', path: 'foo.md' }),
      );
      await h.ctx.end();

      const result = await h.replayer.undo();

      expect(result.transaction).not.toBeNull();
      expect(result.outcomes).toEqual([
        {
          toolName: 'create_note',
          path: 'foo.md',
          inverse: { kind: 'delete-file', path: 'foo.md' },
          ok: true,
        },
      ]);
      expect(result.removedFromLog).toBe(true);
      expect(h.adapter.files.has('foo.md')).toBe(false);
      expect(await h.log.recent()).toHaveLength(0);
    });

    it("reverses an append_to_note (write-file inverse with prior content)", async () => {
      h.adapter.files.set('notes.md', { content: 'before\n\nafter', mtime: 2 });
      h.ctx.begin();
      h.ctx.record(
        makeAppliedOp('append_to_note', 'notes.md', {
          kind: 'write-file',
          path: 'notes.md',
          content: 'before',
        }),
      );
      await h.ctx.end();

      const result = await h.replayer.undo();

      expect(result.removedFromLog).toBe(true);
      expect(h.adapter.files.get('notes.md')?.content).toBe('before');
    });
  });

  describe('undo — multi-op transactions (reverse order)', () => {
    it('replays inverses in REVERSE insertion order', async () => {
      // Simulate a turn that created a.md then b.md.
      h.adapter.files.set('a.md', { content: 'A', mtime: 1 });
      h.adapter.files.set('b.md', { content: 'B', mtime: 2 });

      h.ctx.begin();
      h.ctx.record(makeAppliedOp('create_note', 'a.md', { kind: 'delete-file', path: 'a.md' }));
      h.ctx.record(makeAppliedOp('create_note', 'b.md', { kind: 'delete-file', path: 'b.md' }));
      await h.ctx.end();

      const result = await h.replayer.undo();

      // outcomes recorded in replay order — b first, then a
      expect(result.outcomes.map((o) => o.path)).toEqual(['b.md', 'a.md']);
      expect(result.removedFromLog).toBe(true);
      expect(h.adapter.files.has('a.md')).toBe(false);
      expect(h.adapter.files.has('b.md')).toBe(false);
    });
  });

  describe('undo — partial failure', () => {
    it("aborts on first failure and leaves the transaction in the log", async () => {
      h.adapter.files.set('a.md', { content: 'A', mtime: 1 });
      h.adapter.files.set('b.md', { content: 'B', mtime: 2 });

      h.ctx.begin();
      // Note: outcomes replay in REVERSE — so 'b' (last in) goes first.
      h.ctx.record(makeAppliedOp('create_note', 'a.md', { kind: 'delete-file', path: 'a.md' }));
      h.ctx.record(makeAppliedOp('create_note', 'b.md', { kind: 'delete-file', path: 'b.md' }));
      await h.ctx.end();

      // Fail the FIRST delete call (which targets b.md per reverse order)
      h.adapter.failNext = { op: 'delete', message: 'permission denied' };

      const result = await h.replayer.undo();

      expect(result.removedFromLog).toBe(false);
      expect(result.outcomes).toHaveLength(1); // bailed after the failure
      expect(result.outcomes[0]).toMatchObject({
        path: 'b.md',
        ok: false,
        error: 'permission denied',
      });
      // Both files still present — failed first, never got to a.
      expect(h.adapter.files.has('a.md')).toBe(true);
      expect(h.adapter.files.has('b.md')).toBe(true);
      // Transaction still in log so user can retry
      expect(await h.log.recent()).toHaveLength(1);
    });

    it('handles partial success then failure — earlier successes stay applied, tx stays in log', async () => {
      h.adapter.files.set('a.md', { content: 'A', mtime: 1 });
      h.adapter.files.set('b.md', { content: 'B', mtime: 2 });

      h.ctx.begin();
      h.ctx.record(makeAppliedOp('create_note', 'a.md', { kind: 'delete-file', path: 'a.md' }));
      h.ctx.record(makeAppliedOp('create_note', 'b.md', { kind: 'delete-file', path: 'b.md' }));
      await h.ctx.end();

      // b's delete succeeds; then before a's runs, schedule its delete to fail.
      let deleteCount = 0;
      const origDelete = h.adapter.delete.bind(h.adapter);
      h.adapter.delete = (path: string) => {
        deleteCount++;
        if (deleteCount === 2) {
          return Promise.reject(new Error('disk full'));
        }
        return origDelete(path);
      };

      const result = await h.replayer.undo();

      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes[0]).toMatchObject({ path: 'b.md', ok: true });
      expect(result.outcomes[1]).toMatchObject({ path: 'a.md', ok: false, error: 'disk full' });
      expect(result.removedFromLog).toBe(false);
      expect(h.adapter.files.has('b.md')).toBe(false); // successfully deleted
      expect(h.adapter.files.has('a.md')).toBe(true); // failed delete left it
      expect(await h.log.recent()).toHaveLength(1); // tx still there to retry
    });
  });

  describe('undo — sequencing across multiple calls', () => {
    it('undoes the most recent transaction, then the next on a second call', async () => {
      h.adapter.files.set('a.md', { content: 'A', mtime: 1 });
      h.adapter.files.set('b.md', { content: 'B', mtime: 2 });

      h.ctx.begin('tx1');
      h.ctx.record(makeAppliedOp('create_note', 'a.md', { kind: 'delete-file', path: 'a.md' }));
      await h.ctx.end();
      h.ctx.begin('tx2');
      h.ctx.record(makeAppliedOp('create_note', 'b.md', { kind: 'delete-file', path: 'b.md' }));
      await h.ctx.end();

      // First undo should remove b (most recent)
      const r1 = await h.replayer.undo();
      expect(r1.transaction?.sessionId).toBe('tx2');
      expect(h.adapter.files.has('b.md')).toBe(false);
      expect(h.adapter.files.has('a.md')).toBe(true);

      // Second undo should remove a
      const r2 = await h.replayer.undo();
      expect(r2.transaction?.sessionId).toBe('tx1');
      expect(h.adapter.files.has('a.md')).toBe(false);

      // Third undo: nothing left
      const r3 = await h.replayer.undo();
      expect(r3.transaction).toBeNull();
    });
  });
});
