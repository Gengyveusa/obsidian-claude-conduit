import { beforeEach, describe, expect, it } from 'vitest';

import { insertWikilink, makeLinkNotesTool } from '../../../src/agent/tools/link_notes';
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
    return f === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(f.content);
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
  renameFile(): Promise<void> {
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
}

function makeHarness(): Harness {
  const adapter = new MemAdapter();
  const log = new JsonTransactionLog({ adapter, path: LOG_PATH });
  const ctx = new WriteToolContext(log);
  return { adapter, ctx };
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

describe('insertWikilink (pure)', () => {
  it('appends at end with blank-line separator when no anchor', () => {
    expect(insertWikilink('body line', '[[link]]', undefined)).toBe('body line\n\n[[link]]');
  });

  it("doesn't double-add a separator if content already ends in two newlines", () => {
    expect(insertWikilink('foo\n\n', '[[link]]', undefined)).toBe('foo\n\n[[link]]');
  });

  it('adds one more newline if content ends in a single newline', () => {
    expect(insertWikilink('foo\n', '[[link]]', undefined)).toBe('foo\n\n[[link]]');
  });

  it('returns just the link if content is empty', () => {
    expect(insertWikilink('', '[[link]]', undefined)).toBe('[[link]]');
  });

  it('inserts after the anchor line when anchor is given and matches', () => {
    expect(insertWikilink('a\nanchor here\nb', '[[link]]', 'anchor here')).toBe(
      'a\nanchor here\n[[link]]\nb',
    );
  });

  it('matches anchor trim-equal', () => {
    expect(insertWikilink('a\n  anchor  \nb', '[[link]]', 'anchor')).toBe(
      'a\n  anchor  \n[[link]]\nb',
    );
  });

  it('returns content unchanged when anchor not found', () => {
    expect(insertWikilink('a\nb', '[[link]]', 'missing')).toBe('a\nb');
  });

  it('returns content unchanged when link already exists (no-anchor mode)', () => {
    expect(insertWikilink('foo\n[[link]]\nbar', '[[link]]', undefined)).toBe(
      'foo\n[[link]]\nbar',
    );
  });
});

describe('link_notes', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('appends a wikilink at end on accept', async () => {
    const expected = await stageFile(h.adapter, 'from.md', 'body line');
    const gate = new AcceptAllGate();
    const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx, now: () => 1700000000 });
    h.ctx.begin();
    const result = await tool.handler({
      fromPath: 'from.md',
      toPath: 'to.md',
      ...expected,
    });

    expect(result).toEqual({ status: 'applied', fromPath: 'from.md', toPath: 'to.md' });
    expect(h.adapter.files.get('from.md')?.content).toBe('body line\n\n[[to.md]]');
  });

  it('inserts after the anchor line when anchorInFrom is provided', async () => {
    const expected = await stageFile(h.adapter, 'from.md', 'intro\nanchor here\nrest');
    const gate = new AcceptAllGate();
    const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    await tool.handler({
      fromPath: 'from.md',
      toPath: 'to.md',
      anchorInFrom: 'anchor here',
      ...expected,
    });

    expect(h.adapter.files.get('from.md')?.content).toBe('intro\nanchor here\n[[to.md]]\nrest');
  });

  it('records write-file inverse with prior content', async () => {
    const expected = await stageFile(h.adapter, 'from.md', 'before');
    const gate = new AcceptAllGate();
    const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx, now: () => 1700000000 });
    h.ctx.begin();
    await tool.handler({
      fromPath: 'from.md',
      toPath: 'to.md',
      ...expected,
    });
    const tx = await h.ctx.end();

    expect(tx?.ops[0].inverse).toEqual({
      kind: 'write-file',
      path: 'from.md',
      content: 'before',
    });
  });

  it('emits a patch-file ProposalDiff', async () => {
    const expected = await stageFile(h.adapter, 'from.md', 'body');
    const gate = new AcceptAllGate();
    const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    await tool.handler({
      fromPath: 'from.md',
      toPath: 'to.md',
      ...expected,
    });

    expect(gate.seen[0].diff).toMatchObject({
      kind: 'patch-file',
      path: 'from.md',
      before: 'body',
      after: 'body\n\n[[to.md]]',
    });
  });

  it("returns 'conflict' when expectedHash drifts", async () => {
    h.adapter.files.set('from.md', { content: 'current', mtime: 1 });
    const gate = new AcceptAllGate();
    const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      fromPath: 'from.md',
      toPath: 'to.md',
      expectedMtime: 1,
      expectedHash: await sha256Hex('stale view'),
    });
    expect(result.status).toBe('conflict');
    expect(gate.seen).toHaveLength(0);
  });

  it("returns 'rejected' on user reject", async () => {
    const expected = await stageFile(h.adapter, 'from.md', 'body');
    const gate = new RejectAllGate('not yet');
    const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
    h.ctx.begin();
    const result = await tool.handler({
      fromPath: 'from.md',
      toPath: 'to.md',
      ...expected,
    });

    expect(result).toMatchObject({ status: 'rejected', reason: 'not yet' });
    expect(h.adapter.files.get('from.md')?.content).toBe('body');
  });

  describe('error paths', () => {
    it('errors when fromPath does not exist', async () => {
      const gate = new AcceptAllGate();
      const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({
        fromPath: 'missing.md',
        toPath: 'to.md',
        expectedMtime: 0,
        expectedHash: 'a'.repeat(64),
      });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/does not exist/);
    });

    it('errors when anchor is given but not found', async () => {
      const expected = await stageFile(h.adapter, 'from.md', 'no anchor here');
      const gate = new AcceptAllGate();
      const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({
        fromPath: 'from.md',
        toPath: 'to.md',
        anchorInFrom: 'missing anchor',
        ...expected,
      });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/Anchor line not found/);
    });

    it("errors when link already present (no-op detection)", async () => {
      const expected = await stageFile(h.adapter, 'from.md', 'body\n[[to.md]]');
      const gate = new AcceptAllGate();
      const tool = makeLinkNotesTool({ adapter: h.adapter, gate, ctx: h.ctx });
      h.ctx.begin();
      const result = await tool.handler({
        fromPath: 'from.md',
        toPath: 'to.md',
        ...expected,
      });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/already exists/);
    });
  });
});
