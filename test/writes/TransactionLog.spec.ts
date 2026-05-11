import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { JsonTransactionLog } from '../../src/writes/TransactionLog';
import type { AppliedOp, InverseOp, Transaction } from '../../src/writes/types';

/**
 * In-memory `VaultAdapter` for fast, hermetic tests. Only the methods the
 * TransactionLog touches (`exists`, `read`, `write`) need real behavior;
 * the rest throw if accidentally called (signaling a spec bug).
 */
class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    return Promise.resolve(v);
  }
  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('MemAdapter.readBinary unused in this suite');
  }
  writeBinary(): Promise<void> {
    throw new Error('MemAdapter.writeBinary unused in this suite');
  }
  delete(): Promise<void> {
    throw new Error('MemAdapter.delete unused in this suite');
  }
  renameFile(): Promise<void> {
    throw new Error("unused");
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

function appliedOp(over: Partial<AppliedOp> = {}): AppliedOp {
  const inverse: InverseOp = { kind: 'delete-file', path: 'foo.md' };
  return {
    toolName: 'create_note',
    path: 'foo.md',
    appliedAt: 1700000000,
    inverse,
    ...over,
  };
}

const LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/transactions.json';

describe('JsonTransactionLog', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
  });

  describe('begin → record → commit', () => {
    it('persists a single committed transaction as JSON array', async () => {
      const log = new JsonTransactionLog({
        adapter,
        path: LOG_PATH,
        now: () => 1700_000_000_000,
        randId: () => 'abcdef',
      });
      const tx = log.begin('session-1');
      tx.record(appliedOp());
      const result = await tx.commit();

      expect(result).not.toBeNull();
      expect(result?.id).toBe('1700000000000-abcdef');
      expect(result?.timestamp).toBe(1_700_000_000);
      expect(result?.sessionId).toBe('session-1');
      expect(result?.ops).toHaveLength(1);

      const raw = adapter.files.get(LOG_PATH);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!) as Transaction[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('1700000000000-abcdef');
    });

    it('omits sessionId from the persisted record when not provided', async () => {
      const log = new JsonTransactionLog({
        adapter,
        path: LOG_PATH,
        now: () => 1700_000_000_000,
        randId: () => 'abcdef',
      });
      const tx = log.begin();
      tx.record(appliedOp());
      const result = await tx.commit();

      expect(result?.sessionId).toBeUndefined();
      const parsed = JSON.parse(adapter.files.get(LOG_PATH)!) as Transaction[];
      expect(parsed[0]).not.toHaveProperty('sessionId');
    });

    it('preserves op order across multiple records', async () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log.begin();
      tx.record(appliedOp({ path: 'a.md' }));
      tx.record(appliedOp({ path: 'b.md' }));
      tx.record(appliedOp({ path: 'c.md' }));
      const committed = await tx.commit();

      expect(committed?.ops.map((o) => o.path)).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('returns null and does not persist when the transaction is empty', async () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log.begin();
      const result = await tx.commit();

      expect(result).toBeNull();
      expect(adapter.files.has(LOG_PATH)).toBe(false);
    });
  });

  describe('abandon', () => {
    it('does not persist when the transaction is abandoned', () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log.begin();
      tx.record(appliedOp());
      tx.abandon();

      expect(adapter.files.has(LOG_PATH)).toBe(false);
    });

    it('throws on record() called after abandon()', () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log.begin();
      tx.abandon();
      expect(() => {
        tx.record(appliedOp());
      }).toThrow(/after abandon/);
    });

    it('throws on commit() called after abandon()', async () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log.begin();
      tx.abandon();
      await expect(tx.commit()).rejects.toThrow(/after abandon/);
    });

    it('is idempotent', () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log.begin();
      tx.abandon();
      expect(() => {
        tx.abandon();
      }).not.toThrow();
    });
  });

  describe('recent()', () => {
    it('returns [] when the file does not exist', async () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      expect(await log.recent()).toEqual([]);
    });

    it('returns [] when the file is empty whitespace', async () => {
      adapter.files.set(LOG_PATH, '   \n');
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      expect(await log.recent()).toEqual([]);
    });

    it('returns all transactions when no limit is given', async () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      for (let i = 0; i < 5; i++) {
        const tx = log.begin();
        tx.record(appliedOp({ path: `note-${i}.md` }));
        await tx.commit();
      }
      const all = await log.recent();
      expect(all).toHaveLength(5);
      expect(all.map((t) => t.ops[0].path)).toEqual([
        'note-0.md',
        'note-1.md',
        'note-2.md',
        'note-3.md',
        'note-4.md',
      ]);
    });

    it('returns only the last N when a limit is given', async () => {
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      for (let i = 0; i < 5; i++) {
        const tx = log.begin();
        tx.record(appliedOp({ path: `note-${i}.md` }));
        await tx.commit();
      }
      const last2 = await log.recent(2);
      expect(last2).toHaveLength(2);
      expect(last2.map((t) => t.ops[0].path)).toEqual(['note-3.md', 'note-4.md']);
    });

    it('throws a clear error when the file contains non-array JSON', async () => {
      adapter.files.set(LOG_PATH, JSON.stringify({ wrong: 'shape' }));
      const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
      await expect(log.recent()).rejects.toThrow(/non-array JSON/);
    });
  });

  describe('rolling cap', () => {
    it('drops the oldest entries when exceeding maxEntries', async () => {
      const log = new JsonTransactionLog({
        adapter,
        path: LOG_PATH,
        maxEntries: 3,
      });
      for (let i = 0; i < 5; i++) {
        const tx = log.begin();
        tx.record(appliedOp({ path: `note-${i}.md` }));
        await tx.commit();
      }
      const all = await log.recent();
      expect(all).toHaveLength(3);
      expect(all.map((t) => t.ops[0].path)).toEqual([
        'note-2.md',
        'note-3.md',
        'note-4.md',
      ]);
    });

    it('does not truncate below the cap', async () => {
      const log = new JsonTransactionLog({
        adapter,
        path: LOG_PATH,
        maxEntries: 10,
      });
      for (let i = 0; i < 3; i++) {
        const tx = log.begin();
        tx.record(appliedOp({ path: `note-${i}.md` }));
        await tx.commit();
      }
      expect(await log.recent()).toHaveLength(3);
    });
  });

  describe('id format', () => {
    it('produces sortable ids that include the start timestamp', async () => {
      let t = 1_700_000_000_000;
      const log = new JsonTransactionLog({
        adapter,
        path: LOG_PATH,
        now: () => t,
        randId: () => '000000',
      });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        t += 5;
        const tx = log.begin();
        tx.record(appliedOp());
        const result = await tx.commit();
        ids.push(result!.id);
      }
      expect(ids).toEqual([
        '1700000000005-000000',
        '1700000000010-000000',
        '1700000000015-000000',
      ]);
      // Lexicographic sort matches insertion order
      expect([...ids].sort()).toEqual(ids);
    });
  });

  describe('persistence round-trip', () => {
    it('a log built from a previously persisted file sees prior transactions', async () => {
      const log1 = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const tx = log1.begin('session-x');
      tx.record(appliedOp({ path: 'persisted.md' }));
      await tx.commit();

      // Simulate plugin reload — same adapter (= same disk), new log instance.
      const log2 = new JsonTransactionLog({ adapter, path: LOG_PATH });
      const all = await log2.recent();
      expect(all).toHaveLength(1);
      expect(all[0].ops[0].path).toBe('persisted.md');
      expect(all[0].sessionId).toBe('session-x');
    });
  });
});
