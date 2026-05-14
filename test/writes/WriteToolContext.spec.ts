import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { JsonTransactionLog } from '../../src/writes/TransactionLog';
import { WriteToolContext } from '../../src/writes/WriteToolContext';
import type { AppliedOp } from '../../src/writes/types';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(v);
  }
  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
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

function appliedOp(path: string): AppliedOp {
  return {
    toolName: 'create_note',
    path,
    appliedAt: 1700000000,
    inverse: { kind: 'delete-file', path },
  };
}

const LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/transactions.json';

describe('WriteToolContext', () => {
  let adapter: MemAdapter;
  let log: JsonTransactionLog;
  let ctx: WriteToolContext;

  beforeEach(() => {
    adapter = new MemAdapter();
    log = new JsonTransactionLog({ adapter, path: LOG_PATH });
    ctx = new WriteToolContext(log);
  });

  it('begins false, opens on begin(), closes on end()', async () => {
    expect(ctx.isOpen()).toBe(false);
    ctx.begin();
    expect(ctx.isOpen()).toBe(true);
    await ctx.end();
    expect(ctx.isOpen()).toBe(false);
  });

  it('records and commits an op produced during the turn', async () => {
    ctx.begin('session-x');
    ctx.record(appliedOp('foo.md'));
    const tx = await ctx.end();

    expect(tx).not.toBeNull();
    expect(tx?.ops).toHaveLength(1);
    expect(tx?.sessionId).toBe('session-x');
    expect(tx?.ops[0].path).toBe('foo.md');
  });

  it('records multiple ops in order', async () => {
    ctx.begin();
    ctx.record(appliedOp('a.md'));
    ctx.record(appliedOp('b.md'));
    ctx.record(appliedOp('c.md'));
    const tx = await ctx.end();
    expect(tx?.ops.map((o) => o.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('end() returns null + persists nothing when no ops were recorded', async () => {
    ctx.begin();
    const tx = await ctx.end();
    expect(tx).toBeNull();
    expect(adapter.files.has(LOG_PATH)).toBe(false);
  });

  it('throws when begin() is called twice without an intervening end', () => {
    ctx.begin();
    expect(() => {
      ctx.begin();
    }).toThrow(/already open/);
  });

  it('throws when record() is called without an open transaction', () => {
    expect(() => {
      ctx.record(appliedOp('x.md'));
    }).toThrow(/no transaction is open/);
  });

  it('throws when end() is called without an open transaction', async () => {
    await expect(ctx.end()).rejects.toThrow(/no transaction is open/);
  });

  it('abandon() discards ops without committing', async () => {
    ctx.begin();
    ctx.record(appliedOp('foo.md'));
    ctx.abandon();
    expect(ctx.isOpen()).toBe(false);
    expect(adapter.files.has(LOG_PATH)).toBe(false);

    // recent() still works against an empty / missing file
    const recent = await log.recent();
    expect(recent).toEqual([]);
  });

  it('abandon() is idempotent — no-op when no transaction open', () => {
    expect(() => {
      ctx.abandon();
    }).not.toThrow();
  });

  it('supports multiple sequential turns', async () => {
    ctx.begin('turn-1');
    ctx.record(appliedOp('a.md'));
    await ctx.end();

    ctx.begin('turn-2');
    ctx.record(appliedOp('b.md'));
    await ctx.end();

    const all = await log.recent();
    expect(all).toHaveLength(2);
    expect(all[0].sessionId).toBe('turn-1');
    expect(all[1].sessionId).toBe('turn-2');
  });

  it('survives a turn that abandons then opens a new one', async () => {
    ctx.begin('turn-1');
    ctx.record(appliedOp('a.md'));
    ctx.abandon();

    ctx.begin('turn-2');
    ctx.record(appliedOp('b.md'));
    await ctx.end();

    const all = await log.recent();
    expect(all).toHaveLength(1);
    expect(all[0].sessionId).toBe('turn-2');
  });

  it('forwards source through to the committed Transaction (ADR-025 D5)', async () => {
    ctx.begin('turn-mcp', 'mcp:claude-desktop');
    ctx.record(appliedOp('mcp-write.md'));
    const tx = await ctx.end();

    expect(tx?.source).toBe('mcp:claude-desktop');
    expect(tx?.sessionId).toBe('turn-mcp');
    expect(tx?.ops[0].path).toBe('mcp-write.md');
  });

  it('omits source when not supplied (in-app chat path stays unchanged)', async () => {
    ctx.begin('turn-inapp');
    ctx.record(appliedOp('inapp.md'));
    const tx = await ctx.end();

    expect(tx?.source).toBeUndefined();
  });
});
