import { beforeEach, describe, expect, it } from 'vitest';

import { makePatchNoteTool, type PatchNoteResult } from '../../../src/agent/tools/patch_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { sha256Hex } from '../../../src/writes/ConflictDetector';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import type { PatchOp } from '../../../src/writes/types';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

class MemAdapter implements VaultAdapter {
  files = new Map<string, { content: string; mtime: number }>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const f = this.files.get(path);
    return f === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(f.content);
  }
  write(path: string, content: string): Promise<void> {
    const existing = this.files.get(path);
    this.files.set(path, { content, mtime: (existing?.mtime ?? 0) + 1 });
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
  input: { path: string; ops: PatchOp[]; expectedMtime: number; expectedHash: string },
): Promise<PatchNoteResult> {
  const tool = makePatchNoteTool({
    adapter: h.adapter,
    gate,
    ctx: h.ctx,
    now: () => 1700000000,
  });
  h.ctx.begin('test-session');
  return tool.handler(input);
}

/** Helper: stage a file in the adapter and return its snapshot fields. */
async function stageFile(
  adapter: MemAdapter,
  path: string,
  content: string,
  mtime: number = 100,
): Promise<{ expectedMtime: number; expectedHash: string }> {
  adapter.files.set(path, { content, mtime });
  return {
    expectedMtime: mtime,
    expectedHash: await sha256Hex(content),
  };
}

describe('patch_note', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('accept path', () => {
    it('applies a single replace op and records inverse', async () => {
      const expected = await stageFile(h.adapter, 'notes.md', 'a\nb\nc');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: 'notes.md',
        ops: [{ kind: 'replace', startLine: 2, endLine: 2, content: 'B' }],
        ...expected,
      });

      expect(result).toEqual({ status: 'applied', path: 'notes.md' });
      expect(h.adapter.files.get('notes.md')?.content).toBe('a\nB\nc');

      const tx = await h.ctx.end();
      expect(tx?.ops[0]).toEqual({
        toolName: 'patch_note',
        path: 'notes.md',
        appliedAt: 1700000000,
        inverse: { kind: 'write-file', path: 'notes.md', content: 'a\nb\nc' },
      });
    });

    it('applies multi-op patch in reverse position order', async () => {
      const expected = await stageFile(h.adapter, 'notes.md', '1\n2\n3\n4\n5');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: 'notes.md',
        ops: [
          { kind: 'replace', startLine: 1, endLine: 1, content: 'A' },
          { kind: 'delete', startLine: 3, endLine: 3 },
          { kind: 'insert', afterLine: 5, content: 'F' },
        ],
        ...expected,
      });

      expect(result.status).toBe('applied');
      expect(h.adapter.files.get('notes.md')?.content).toBe('A\n2\n4\n5\nF');
    });

    it('emits a patch-file ProposalDiff with before + after', async () => {
      const expected = await stageFile(h.adapter, 'notes.md', 'a\nb');
      const gate = new AcceptAllGate();
      await runHandler(h, gate, {
        path: 'notes.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'A' }],
        ...expected,
      });

      expect(gate.seen[0].diff).toEqual({
        kind: 'patch-file',
        path: 'notes.md',
        before: 'a\nb',
        after: 'A\nb',
      });
    });
  });

  describe('conflict path', () => {
    it("returns 'conflict' when expectedHash doesn't match current state", async () => {
      h.adapter.files.set('notes.md', { content: 'current content', mtime: 100 });
      const wrongHash = await sha256Hex('what the LLM thought was there');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: 'notes.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'X' }],
        expectedMtime: 100,
        expectedHash: wrongHash,
      });

      expect(result.status).toBe('conflict');
      expect(result.reason).toMatch(/hash drifted/);
      expect(gate.seen).toHaveLength(0); // never even proposed
      expect(h.adapter.files.get('notes.md')?.content).toBe('current content');
    });

    it("returns 'conflict' when the file changes between propose and accept", async () => {
      const expected = await stageFile(h.adapter, 'notes.md', 'a\nb');
      const adapter = h.adapter;

      // Custom gate that mutates the file before returning accept — simulates
      // the user editing in Obsidian while the diff card is up.
      const seen: unknown[] = [];
      const racingGate = {
        seen,
        request: (proposal: unknown) => {
          seen.push(proposal);
          adapter.files.set('notes.md', { content: 'user edit', mtime: 200 });
          return Promise.resolve({ kind: 'accept' as const });
        },
      };

      const tool = makePatchNoteTool({
        adapter: h.adapter,
        gate: racingGate,
        ctx: h.ctx,
        now: () => 1700000000,
      });
      h.ctx.begin('test-session');
      const result = await tool.handler({
        path: 'notes.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'A' }],
        ...expected,
      });

      expect(result.status).toBe('conflict');
      expect(result.reason).toMatch(/Write conflict/);
      // Adapter still shows the user's edit — patch was not applied
      expect(h.adapter.files.get('notes.md')?.content).toBe('user edit');
    });
  });

  describe('reject path', () => {
    it("does nothing and returns 'rejected' with reason", async () => {
      const expected = await stageFile(h.adapter, 'notes.md', 'a\nb');
      const gate = new RejectAllGate('not now');
      const result = await runHandler(h, gate, {
        path: 'notes.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'A' }],
        ...expected,
      });

      expect(result).toEqual({ status: 'rejected', path: 'notes.md', reason: 'not now' });
      expect(h.adapter.files.get('notes.md')?.content).toBe('a\nb');
    });
  });

  describe('error paths (proposal never goes to gate)', () => {
    it("returns 'error' for path traversal", async () => {
      await stageFile(h.adapter, 'notes.md', 'a');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: '../escape.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'X' }],
        expectedMtime: 100,
        expectedHash: 'a'.repeat(64),
      });
      expect(result.status).toBe('error');
      expect(gate.seen).toHaveLength(0);
    });

    it("returns 'error' when the file doesn't exist", async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: 'missing.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'X' }],
        expectedMtime: 100,
        expectedHash: 'a'.repeat(64),
      });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/does not exist/);
    });

    it("returns 'error' when ops reference a line beyond EOF", async () => {
      const expected = await stageFile(h.adapter, 'short.md', 'one line');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: 'short.md',
        ops: [{ kind: 'replace', startLine: 99, endLine: 99, content: 'X' }],
        ...expected,
      });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/startLine must be/);
    });
  });

  describe('schema validation', () => {
    it('rejects an empty ops array', () => {
      const tool = makePatchNoteTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      const result = tool.inputSchema.safeParse({
        path: 'foo.md',
        ops: [],
        expectedMtime: 0,
        expectedHash: 'a'.repeat(64),
      });
      expect(result.success).toBe(false);
    });

    it('rejects a non-64-hex expectedHash', () => {
      const tool = makePatchNoteTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      const result = tool.inputSchema.safeParse({
        path: 'foo.md',
        ops: [{ kind: 'replace', startLine: 1, endLine: 1, content: 'X' }],
        expectedMtime: 0,
        expectedHash: 'not-a-hash',
      });
      expect(result.success).toBe(false);
    });

    it('accepts a well-formed input', () => {
      const tool = makePatchNoteTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      const result = tool.inputSchema.safeParse({
        path: 'foo.md',
        ops: [{ kind: 'insert', afterLine: 0, content: 'X' }],
        expectedMtime: 100,
        expectedHash: 'a'.repeat(64),
      });
      expect(result.success).toBe(true);
    });
  });

  it('has the expected name and description', () => {
    const tool = makePatchNoteTool({
      adapter: h.adapter,
      gate: new AcceptAllGate(),
      ctx: h.ctx,
    });
    expect(tool.name).toBe('patch_note');
    expect(tool.description).toMatch(/structured ops/i);
  });
});
