import { beforeEach, describe, expect, it } from 'vitest';

import { makeDeleteNoteTool, type DeleteNoteResult } from '../../../src/agent/tools/delete_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  deleted: string[] = [];

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
  delete(path: string): Promise<void> {
    if (!this.files.has(path)) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    this.deleted.push(path);
    this.files.delete(path);
    return Promise.resolve();
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

async function runHandler(
  h: Harness,
  gate: AcceptAllGate | RejectAllGate,
  input: { path: string },
  beginCtx: boolean = true,
): Promise<DeleteNoteResult> {
  const tool = makeDeleteNoteTool({
    adapter: h.adapter,
    gate,
    ctx: h.ctx,
    now: () => 1700000000,
  });
  if (beginCtx) {
    h.ctx.begin('test-session');
  }
  return tool.handler(input);
}

describe('delete_note', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('accept path', () => {
    it('deletes the file and returns applied', async () => {
      h.adapter.files.set('doomed.md', 'goodbye');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'doomed.md' });

      expect(result).toEqual({ status: 'applied', path: 'doomed.md' });
      expect(h.adapter.files.has('doomed.md')).toBe(false);
      expect(h.adapter.deleted).toEqual(['doomed.md']);
    });

    it('records an inverse write-file op preserving the prior content', async () => {
      h.adapter.files.set('subdir/doomed.md', 'prior\nbody');
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'subdir/doomed.md' });
      const tx = await h.ctx.end();

      expect(tx).not.toBeNull();
      expect(tx?.ops).toHaveLength(1);
      expect(tx?.ops[0]).toEqual({
        toolName: 'delete_note',
        path: 'subdir/doomed.md',
        appliedAt: 1700000000,
        inverse: { kind: 'write-file', path: 'subdir/doomed.md', content: 'prior\nbody' },
      });
    });

    it('proposes a delete-file diff with the prior content', async () => {
      h.adapter.files.set('foo.md', 'line one\nline two');
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'foo.md' });

      expect(gate.seen).toHaveLength(1);
      expect(gate.seen[0].diff).toEqual({
        kind: 'delete-file',
        path: 'foo.md',
        content: 'line one\nline two',
      });
    });
  });

  describe('reject path', () => {
    it('leaves the file in place and returns rejected', async () => {
      h.adapter.files.set('safe.md', 'still here');
      const gate = new RejectAllGate('user said no');
      const result = await runHandler(h, gate, { path: 'safe.md' });

      expect(result).toEqual({ status: 'rejected', path: 'safe.md', reason: 'user said no' });
      expect(h.adapter.files.get('safe.md')).toBe('still here');
      expect(h.adapter.deleted).toEqual([]);
    });

    it('records nothing in the transaction log on reject', async () => {
      h.adapter.files.set('foo.md', 'x');
      const gate = new RejectAllGate();
      await runHandler(h, gate, { path: 'foo.md' });
      const tx = await h.ctx.end();
      expect(tx).toBeNull();
    });
  });

  describe('error paths (never reach the gate)', () => {
    it('returns error on path traversal', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: '../outside.md' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/'\.\.'/);
      expect(gate.seen).toHaveLength(0);
    });

    it('returns error when the file does not exist', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'missing.md' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/does not exist/);
      expect(gate.seen).toHaveLength(0);
      expect(h.adapter.deleted).toEqual([]);
    });

    it('rejects absolute paths', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: '/etc/passwd' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/absolute path/);
    });
  });

  describe('JSON schema and metadata', () => {
    it('rejects empty path via schema', () => {
      const tool = makeDeleteNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      expect(tool.inputSchema.safeParse({ path: '' }).success).toBe(false);
    });

    it('has the expected name and description', () => {
      const tool = makeDeleteNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      expect(tool.name).toBe('delete_note');
      expect(tool.description).toMatch(/Propose deleting/);
    });
  });
});
