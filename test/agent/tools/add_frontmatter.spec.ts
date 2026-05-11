import { beforeEach, describe, expect, it } from 'vitest';

import { makeAddFrontmatterTool } from '../../../src/agent/tools/add_frontmatter';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { sha256Hex } from '../../../src/writes/ConflictDetector';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

class MemAdapter implements VaultAdapter {
  files = new Map<string, { content: string; mtime: number }>();
  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const f = this.files.get(p);
    return f === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(f.content);
  }
  write(p: string, c: string): Promise<void> {
    const ex = this.files.get(p);
    this.files.set(p, { content: c, mtime: (ex?.mtime ?? 0) + 1 });
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
  stat(p: string): Promise<VaultStat | null> {
    const f = this.files.get(p);
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

async function stageFile(
  adapter: MemAdapter,
  path: string,
  content: string,
  mtime = 100,
): Promise<{ expectedMtime: number; expectedHash: string }> {
  adapter.files.set(path, { content, mtime });
  return { expectedMtime: mtime, expectedHash: await sha256Hex(content) };
}

describe('add_frontmatter', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('adds a string field when no frontmatter exists', async () => {
    const expected = await stageFile(h.adapter, 'n.md', 'body only');
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      key: 'title',
      value: 'Hello',
      ...expected,
    });

    expect(result.status).toBe('applied');
    expect(h.adapter.files.get('n.md')?.content).toBe('---\ntitle: Hello\n---\nbody only');
  });

  it('upserts a key into an existing block', async () => {
    const expected = await stageFile(h.adapter, 'n.md', '---\ntags:\n  - a\n---\nbody');
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    await tool.handler({
      path: 'n.md',
      key: 'title',
      value: 'T',
      ...expected,
    });

    const after = h.adapter.files.get('n.md')!.content;
    expect(after).toContain('title: T');
    expect(after).toContain('- a');
    expect(after.endsWith('\nbody')).toBe(true);
  });

  it('records inverse write-file with the prior content', async () => {
    const expected = await stageFile(h.adapter, 'n.md', 'before');
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      now: () => 1700000000,
    });
    h.ctx.begin();
    await tool.handler({
      path: 'n.md',
      key: 'x',
      value: 1,
      ...expected,
    });
    const tx = await h.ctx.end();

    expect(tx?.ops[0].inverse).toEqual({
      kind: 'write-file',
      path: 'n.md',
      content: 'before',
    });
  });

  it('accepts number, boolean, and string[] values', async () => {
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });

    const e1 = await stageFile(h.adapter, 'a.md', 'body');
    h.ctx.begin();
    await tool.handler({ path: 'a.md', key: 'priority', value: 3, ...e1 });
    expect(h.adapter.files.get('a.md')?.content).toContain('priority: 3');
    await h.ctx.end();

    const e2 = await stageFile(h.adapter, 'b.md', 'body');
    h.ctx.begin();
    await tool.handler({ path: 'b.md', key: 'archived', value: true, ...e2 });
    expect(h.adapter.files.get('b.md')?.content).toContain('archived: true');
    await h.ctx.end();

    const e3 = await stageFile(h.adapter, 'c.md', 'body');
    h.ctx.begin();
    await tool.handler({ path: 'c.md', key: 'tags', value: ['a', 'b'], ...e3 });
    expect(h.adapter.files.get('c.md')?.content).toMatch(/tags:\s*\n\s*-\s*a/);
  });

  it('returns conflict when expectedHash drifts', async () => {
    h.adapter.files.set('n.md', { content: 'current', mtime: 1 });
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      key: 'x',
      value: 1,
      expectedMtime: 1,
      expectedHash: await sha256Hex('stale'),
    });

    expect(result.status).toBe('conflict');
    expect(gate.seen).toHaveLength(0);
  });

  it('returns rejected on user reject', async () => {
    const expected = await stageFile(h.adapter, 'n.md', 'body');
    const gate = new RejectAllGate('nope');
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      key: 'x',
      value: 1,
      ...expected,
    });

    expect(result).toEqual({ status: 'rejected', path: 'n.md', reason: 'nope' });
    expect(h.adapter.files.get('n.md')?.content).toBe('body');
  });

  it('errors when the file does not exist', async () => {
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'missing.md',
      key: 'x',
      value: 1,
      expectedMtime: 0,
      expectedHash: 'a'.repeat(64),
    });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/does not exist/);
  });

  it('errors when existing frontmatter is malformed', async () => {
    const expected = await stageFile(h.adapter, 'n.md', '---\nbad: [unclosed\n---\nbody');
    const gate = new AcceptAllGate();
    const tool = makeAddFrontmatterTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      key: 'x',
      value: 1,
      ...expected,
    });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/malformed/);
  });

  describe('schema validation', () => {
    const baseInput = {
      path: 'n.md',
      expectedMtime: 0,
      expectedHash: 'a'.repeat(64),
      value: 'x',
    };

    it('rejects an empty key', () => {
      const tool = makeAddFrontmatterTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      expect(tool.inputSchema.safeParse({ ...baseInput, key: '' }).success).toBe(false);
    });

    it('rejects a key with spaces or punctuation', () => {
      const tool = makeAddFrontmatterTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      expect(tool.inputSchema.safeParse({ ...baseInput, key: 'has space' }).success).toBe(false);
      expect(tool.inputSchema.safeParse({ ...baseInput, key: 'with.dot' }).success).toBe(false);
    });

    it('accepts simple identifier keys', () => {
      const tool = makeAddFrontmatterTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
      });
      expect(tool.inputSchema.safeParse({ ...baseInput, key: 'title' }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ ...baseInput, key: 'created_at' }).success).toBe(true);
      expect(tool.inputSchema.safeParse({ ...baseInput, key: 'note-id' }).success).toBe(true);
    });
  });
});
