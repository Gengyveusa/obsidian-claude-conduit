import { beforeEach, describe, expect, it } from 'vitest';

import { makeCreateNoteTool, type CreateNoteResult } from '../../../src/agent/tools/create_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  mkdirs: string[] = [];

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
  mkdir(path: string): Promise<void> {
    this.mkdirs.push(path);
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
  log: JsonTransactionLog;
}

function makeHarness(): Harness {
  const adapter = new MemAdapter();
  const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
  const ctx = new WriteToolContext(log);
  return { adapter, ctx, log };
}

async function runHandler(
  h: Harness,
  gate: AcceptAllGate | RejectAllGate,
  input: { path: string; content: string },
  beginCtx: boolean = true,
): Promise<CreateNoteResult> {
  const tool = makeCreateNoteTool({
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

describe('create_note', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('accept path', () => {
    it("writes the file and records an 'applied' result", async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'foo.md', content: 'hello' });

      expect(result).toEqual({ status: 'applied', path: 'foo.md' });
      expect(h.adapter.files.get('foo.md')).toBe('hello');
    });

    it('records the inverse op (delete-file) in the transaction log', async () => {
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'subdir/foo.md', content: 'x' });
      const tx = await h.ctx.end();

      expect(tx).not.toBeNull();
      expect(tx?.ops).toHaveLength(1);
      expect(tx?.ops[0]).toEqual({
        toolName: 'create_note',
        path: 'subdir/foo.md',
        appliedAt: 1700000000,
        inverse: { kind: 'delete-file', path: 'subdir/foo.md' },
      });
    });

    it('sends a create-file diff in the proposal', async () => {
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'foo.md', content: 'hello world' });

      expect(gate.seen).toHaveLength(1);
      expect(gate.seen[0].diff).toEqual({
        kind: 'create-file',
        path: 'foo.md',
        content: 'hello world',
      });
    });
  });

  describe('reject path', () => {
    it("does not write the file and returns 'rejected' with reason", async () => {
      const gate = new RejectAllGate('user said no');
      const result = await runHandler(h, gate, { path: 'foo.md', content: 'x' });

      expect(result).toEqual({ status: 'rejected', path: 'foo.md', reason: 'user said no' });
      expect(h.adapter.files.has('foo.md')).toBe(false);
    });

    it('records nothing in the transaction log on reject', async () => {
      const gate = new RejectAllGate();
      await runHandler(h, gate, { path: 'foo.md', content: 'x' });
      const tx = await h.ctx.end();
      expect(tx).toBeNull();
    });
  });

  describe('error paths (proposal never even goes to gate)', () => {
    it('returns error on path-traversal attempt', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: '../outside.md', content: 'x' });

      expect(result.status).toBe('error');
      expect(result.path).toBe('../outside.md');
      expect(result.error).toMatch(/'\.\.'/);
      expect(gate.seen).toHaveLength(0);
      expect(h.adapter.files.has('../outside.md')).toBe(false);
    });

    it('returns error when the file already exists', async () => {
      h.adapter.files.set('exists.md', 'prior content');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'exists.md', content: 'new content' });

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/already exists/);
      expect(gate.seen).toHaveLength(0);
      expect(h.adapter.files.get('exists.md')).toBe('prior content');
    });

    it('rejects absolute paths', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: '/etc/passwd', content: 'x' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/absolute path/);
    });
  });

  describe('JSON schema and metadata', () => {
    it('exposes a Zod schema that rejects empty path', () => {
      const tool = makeCreateNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      const result = tool.inputSchema.safeParse({ path: '', content: 'x' });
      expect(result.success).toBe(false);
    });

    it('exposes a Zod schema that requires content', () => {
      const tool = makeCreateNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      const result = tool.inputSchema.safeParse({ path: 'foo.md' });
      expect(result.success).toBe(false);
    });

    it('has the expected name and description', () => {
      const tool = makeCreateNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      expect(tool.name).toBe('create_note');
      expect(tool.description).toMatch(/Propose creating/);
    });
  });
});
