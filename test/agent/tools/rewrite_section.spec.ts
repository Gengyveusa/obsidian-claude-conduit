import { beforeEach, describe, expect, it } from 'vitest';

import { makeRewriteSectionTool } from '../../../src/agent/tools/rewrite_section';
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
  delete(): Promise<void> {
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

describe('rewrite_section', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('replaces a section body on accept', async () => {
    const expected = await stageFile(h.adapter, 'note.md', '# A\nold\n# B\ntail');
    const gate = new AcceptAllGate();
    const tool = makeRewriteSectionTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      now: () => 1700000000,
    });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'note.md',
      sectionHeader: '# A',
      newBody: 'new content',
      ...expected,
    });

    expect(result).toEqual({ status: 'applied', path: 'note.md' });
    expect(h.adapter.files.get('note.md')?.content).toBe('# A\nnew content\n# B\ntail');

    const tx = await h.ctx.end();
    expect(tx?.ops[0].toolName).toBe('rewrite_section');
    expect(tx?.ops[0].inverse).toEqual({
      kind: 'write-file',
      path: 'note.md',
      content: '# A\nold\n# B\ntail',
    });
  });

  it('emits patch-file diff with before+after', async () => {
    const expected = await stageFile(h.adapter, 'n.md', '# A\nold\n# B\ntail');
    const gate = new AcceptAllGate();
    const tool = makeRewriteSectionTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    await tool.handler({
      path: 'n.md',
      sectionHeader: '# A',
      newBody: 'new',
      ...expected,
    });

    expect(gate.seen[0].diff).toEqual({
      kind: 'patch-file',
      path: 'n.md',
      before: '# A\nold\n# B\ntail',
      after: '# A\nnew\n# B\ntail',
    });
  });

  it('returns conflict when expectedHash drifts', async () => {
    h.adapter.files.set('n.md', { content: 'current', mtime: 1 });
    const gate = new AcceptAllGate();
    const tool = makeRewriteSectionTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      sectionHeader: '# A',
      newBody: 'new',
      expectedMtime: 1,
      expectedHash: await sha256Hex('stale view'),
    });

    expect(result.status).toBe('conflict');
    expect(gate.seen).toHaveLength(0);
  });

  it('returns rejected on user reject', async () => {
    const expected = await stageFile(h.adapter, 'n.md', '# A\nold');
    const gate = new RejectAllGate('not now');
    const tool = makeRewriteSectionTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      sectionHeader: '# A',
      newBody: 'new',
      ...expected,
    });

    expect(result).toEqual({ status: 'rejected', path: 'n.md', reason: 'not now' });
    expect(h.adapter.files.get('n.md')?.content).toBe('# A\nold');
  });

  it('errors when the section is not found', async () => {
    const expected = await stageFile(h.adapter, 'n.md', '# A\nold');
    const gate = new AcceptAllGate();
    const tool = makeRewriteSectionTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      path: 'n.md',
      sectionHeader: '## Missing',
      newBody: 'x',
      ...expected,
    });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no heading/);
  });

  it('schema requires a # prefix on sectionHeader', () => {
    const tool = makeRewriteSectionTool({
      adapter: h.adapter,
      gate: new AcceptAllGate(),
      ctx: h.ctx,
    });
    expect(
      tool.inputSchema.safeParse({
        path: 'n.md',
        sectionHeader: 'No prefix',
        newBody: 'x',
        expectedMtime: 0,
        expectedHash: 'a'.repeat(64),
      }).success,
    ).toBe(false);
  });
});
