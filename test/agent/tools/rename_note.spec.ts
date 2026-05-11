import { beforeEach, describe, expect, it } from 'vitest';

import { makeRenameNoteTool } from '../../../src/agent/tools/rename_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate } from '../../../src/writes/ApprovalGate';
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

describe('rename_note', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('renames within the same folder, auto-appending .md', async () => {
    h.adapter.files.set('70-Memory/foo.md', 'x');
    const gate = new AcceptAllGate();
    const tool = makeRenameNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({ path: '70-Memory/foo.md', newName: 'bar' });

    expect(result).toEqual({
      status: 'applied',
      fromPath: '70-Memory/foo.md',
      toPath: '70-Memory/bar.md',
    });
    expect(h.adapter.files.has('70-Memory/foo.md')).toBe(false);
    expect(h.adapter.files.get('70-Memory/bar.md')).toBe('x');
  });

  it('handles root-level files (no folder prefix)', async () => {
    h.adapter.files.set('root.md', 'y');
    const gate = new AcceptAllGate();
    const tool = makeRenameNoteTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({ path: 'root.md', newName: 'renamed' });

    expect(result.status).toBe('applied');
    expect(result.toPath).toBe('renamed.md');
    expect(h.adapter.files.get('renamed.md')).toBe('y');
  });

  describe('schema validation', () => {
    it('rejects newName containing a slash', () => {
      const tool = makeRenameNoteTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      expect(
        tool.inputSchema.safeParse({ path: 'a.md', newName: 'sub/foo' }).success,
      ).toBe(false);
    });

    it('rejects newName starting with "."', () => {
      const tool = makeRenameNoteTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      expect(
        tool.inputSchema.safeParse({ path: 'a.md', newName: '.hidden' }).success,
      ).toBe(false);
    });

    it('accepts plain identifier-style names', () => {
      const tool = makeRenameNoteTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      expect(
        tool.inputSchema.safeParse({ path: 'a.md', newName: 'Hello World' }).success,
      ).toBe(true);
    });
  });
});
