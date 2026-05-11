import { beforeEach, describe, expect, it } from 'vitest';

import { makeMoveNoteTool } from '../../../src/agent/tools/move_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

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
  delete(p: string): Promise<void> {
    this.files.delete(p);
    return Promise.resolve();
  }
  renameFile(oldPath: string, newPath: string): Promise<void> {
    const c = this.files.get(oldPath);
    if (c === undefined) {
      return Promise.reject(new Error(`ENOENT: ${oldPath}`));
    }
    if (this.files.has(newPath)) {
      return Promise.reject(new Error(`EEXIST: ${newPath}`));
    }
    this.files.delete(oldPath);
    this.files.set(newPath, c);
    return Promise.resolve();
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

const LOG_PATH = '.obsidian/plugins/obsidian-claude-conduit/transactions.json';

interface Harness {
  adapter: MemAdapter;
  ctx: WriteToolContext;
}

function makeHarness(): Harness {
  const adapter = new MemAdapter();
  const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
  const ctx = new WriteToolContext(log);
  return { adapter, ctx };
}

describe('move_note', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('moves the file and records a rename-file inverse', async () => {
    h.adapter.files.set('70-Memory/foo.md', 'hi');
    const gate = new AcceptAllGate();
    const tool = makeMoveNoteTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      now: () => 1700000000,
    });
    h.ctx.begin();
    const result = await tool.handler({
      fromPath: '70-Memory/foo.md',
      toPath: '90-test/foo.md',
    });

    expect(result).toEqual({
      status: 'applied',
      fromPath: '70-Memory/foo.md',
      toPath: '90-test/foo.md',
    });
    expect(h.adapter.files.has('70-Memory/foo.md')).toBe(false);
    expect(h.adapter.files.get('90-test/foo.md')).toBe('hi');

    const tx = await h.ctx.end();
    expect(tx?.ops[0].inverse).toEqual({
      kind: 'rename-file',
      from: '90-test/foo.md',
      to: '70-Memory/foo.md',
    });
  });

  it('emits a rename-file ProposalDiff', async () => {
    h.adapter.files.set('a.md', 'x');
    const gate = new AcceptAllGate();
    const tool = makeMoveNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    await tool.handler({ fromPath: 'a.md', toPath: 'sub/a.md' });

    expect(gate.seen[0].diff).toEqual({
      kind: 'rename-file',
      fromPath: 'a.md',
      toPath: 'sub/a.md',
    });
  });

  it("returns 'rejected' on user reject", async () => {
    h.adapter.files.set('a.md', 'x');
    const gate = new RejectAllGate('not yet');
    const tool = makeMoveNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({ fromPath: 'a.md', toPath: 'b.md' });

    expect(result).toEqual({
      status: 'rejected',
      fromPath: 'a.md',
      toPath: 'b.md',
      reason: 'not yet',
    });
    expect(h.adapter.files.has('a.md')).toBe(true);
  });

  describe('error paths', () => {
    it('errors when fromPath does not exist', async () => {
      const gate = new AcceptAllGate();
      const tool = makeMoveNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({ fromPath: 'missing.md', toPath: 'x.md' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/does not exist/);
      expect(gate.seen).toHaveLength(0);
    });

    it('errors when toPath already exists (no clobber)', async () => {
      h.adapter.files.set('a.md', 'x');
      h.adapter.files.set('b.md', 'y');
      const gate = new AcceptAllGate();
      const tool = makeMoveNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({ fromPath: 'a.md', toPath: 'b.md' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/already exists/);
      expect(gate.seen).toHaveLength(0);
      // Source untouched
      expect(h.adapter.files.get('a.md')).toBe('x');
      expect(h.adapter.files.get('b.md')).toBe('y');
    });

    it('errors when fromPath === toPath (silent no-op guard)', async () => {
      h.adapter.files.set('a.md', 'x');
      const gate = new AcceptAllGate();
      const tool = makeMoveNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({ fromPath: 'a.md', toPath: 'a.md' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/identical/);
    });

    it('errors on path traversal', async () => {
      const gate = new AcceptAllGate();
      const tool = makeMoveNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({ fromPath: '../escape.md', toPath: 'x.md' });
      expect(result.status).toBe('error');
      expect(gate.seen).toHaveLength(0);
    });
  });

  it('has the expected name + description', () => {
    const tool = makeMoveNoteTool({
      adapter: h.adapter,
      gate: new AcceptAllGate(),
      ctx: h.ctx,
    });
    expect(tool.name).toBe('move_note');
    expect(tool.description).toMatch(/moving a markdown file/i);
  });
});
