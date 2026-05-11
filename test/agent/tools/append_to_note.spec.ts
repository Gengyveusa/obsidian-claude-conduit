import { beforeEach, describe, expect, it } from 'vitest';

import {
  appendWithSeparator,
  makeAppendToNoteTool,
  type AppendToNoteResult,
} from '../../../src/agent/tools/append_to_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

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

describe('appendWithSeparator (pure)', () => {
  it('returns just the addition when prior is empty', () => {
    expect(appendWithSeparator('', 'hello')).toBe('hello');
  });

  it('appends with no extra newline when prior ends in two newlines', () => {
    expect(appendWithSeparator('foo\n\n', 'bar')).toBe('foo\n\nbar');
  });

  it('inserts one more newline when prior ends in a single newline', () => {
    expect(appendWithSeparator('foo\n', 'bar')).toBe('foo\n\nbar');
  });

  it('inserts a blank-line separator when prior ends in plain text', () => {
    expect(appendWithSeparator('foo', 'bar')).toBe('foo\n\nbar');
  });

  it('preserves arbitrary trailing whitespace in the prior content', () => {
    // 'foo   ' is plain text-ending; gets the '\n\n' separator
    expect(appendWithSeparator('foo   ', 'bar')).toBe('foo   \n\nbar');
  });
});

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
  input: { path: string; content: string; createIfMissing?: boolean },
  beginCtx: boolean = true,
): Promise<AppendToNoteResult> {
  const tool = makeAppendToNoteTool({
    adapter: h.adapter,
    gate,
    ctx: h.ctx,
    now: () => 1700000000,
  });
  if (beginCtx) {
    h.ctx.begin('test-session');
  }
  // Parse through Zod so .default() fires (matches production via ToolRegistry).
  const parsed = tool.inputSchema.parse(input);
  return tool.handler(parsed);
}

describe('append_to_note', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('accept path on an existing file', () => {
    it('appends with a blank-line separator', async () => {
      h.adapter.files.set('notes.md', 'original');
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'notes.md', content: 'addition' });

      expect(result).toEqual({ status: 'applied', path: 'notes.md' });
      expect(h.adapter.files.get('notes.md')).toBe('original\n\naddition');
    });

    it('records a write-file inverse op with the prior content', async () => {
      h.adapter.files.set('notes.md', 'before');
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'notes.md', content: 'after' });
      const tx = await h.ctx.end();

      expect(tx?.ops[0].inverse).toEqual({
        kind: 'write-file',
        path: 'notes.md',
        content: 'before',
      });
    });

    it('sends an append-to-file diff with the existing tail', async () => {
      h.adapter.files.set('notes.md', 'line1\nline2\nline3');
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'notes.md', content: 'appended' });

      expect(gate.seen[0].diff).toEqual({
        kind: 'append-to-file',
        path: 'notes.md',
        existingTail: 'line1\nline2\nline3',
        appendedContent: 'appended',
      });
    });

    it('limits existingTail to the last 5 lines', async () => {
      h.adapter.files.set('notes.md', 'a\nb\nc\nd\ne\nf\ng');
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'notes.md', content: 'h' });

      expect(gate.seen[0].diff).toMatchObject({
        kind: 'append-to-file',
        existingTail: 'c\nd\ne\nf\ng',
      });
    });
  });

  describe('createIfMissing', () => {
    it('errors if the file is missing and createIfMissing is false (default)', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'missing.md', content: 'x' });

      expect(result.status).toBe('error');
      expect(result.error).toMatch(/does not exist/);
      expect(gate.seen).toHaveLength(0);
    });

    it('creates the file if createIfMissing is true', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, {
        path: 'fresh.md',
        content: 'new content',
        createIfMissing: true,
      });

      expect(result).toEqual({ status: 'applied', path: 'fresh.md' });
      expect(h.adapter.files.get('fresh.md')).toBe('new content');
    });

    it('records a delete-file inverse op when creating via createIfMissing', async () => {
      const gate = new AcceptAllGate();
      await runHandler(h, gate, { path: 'fresh.md', content: 'x', createIfMissing: true });
      const tx = await h.ctx.end();

      expect(tx?.ops[0].inverse).toEqual({ kind: 'delete-file', path: 'fresh.md' });
    });
  });

  describe('reject path', () => {
    it('does not write and returns rejected with reason', async () => {
      h.adapter.files.set('notes.md', 'untouched');
      const gate = new RejectAllGate('changed mind');
      const result = await runHandler(h, gate, { path: 'notes.md', content: 'x' });

      expect(result).toEqual({ status: 'rejected', path: 'notes.md', reason: 'changed mind' });
      expect(h.adapter.files.get('notes.md')).toBe('untouched');
    });
  });

  describe('error paths', () => {
    it('rejects parent-dir traversal', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: 'foo/../bar.md', content: 'x' });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/'\.\.'/);
      expect(gate.seen).toHaveLength(0);
    });

    it('rejects absolute paths', async () => {
      const gate = new AcceptAllGate();
      const result = await runHandler(h, gate, { path: '/etc/passwd', content: 'x' });
      expect(result.status).toBe('error');
    });
  });

  describe('JSON schema and metadata', () => {
    it('exposes a Zod schema that rejects empty path', () => {
      const tool = makeAppendToNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      expect(tool.inputSchema.safeParse({ path: '', content: 'x' }).success).toBe(false);
    });

    it('exposes a default of false for createIfMissing', () => {
      const tool = makeAppendToNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      const parsed = tool.inputSchema.parse({ path: 'foo.md', content: 'x' });
      expect(parsed.createIfMissing).toBe(false);
    });

    it('has the expected name and description', () => {
      const tool = makeAppendToNoteTool({ adapter: h.adapter, gate: new AcceptAllGate(), ctx: h.ctx });
      expect(tool.name).toBe('append_to_note');
      expect(tool.description).toMatch(/append/i);
    });
  });
});
