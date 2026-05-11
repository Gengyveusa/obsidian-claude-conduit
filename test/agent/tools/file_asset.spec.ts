import { beforeEach, describe, expect, it } from 'vitest';

import {
  base64ToArrayBuffer,
  makeFileAssetTool,
} from '../../../src/agent/tools/file_asset';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';
import { AcceptAllGate, RejectAllGate } from '../../../src/writes/ApprovalGate';
import { JsonTransactionLog } from '../../../src/writes/TransactionLog';
import { WriteToolContext } from '../../../src/writes/WriteToolContext';

class MemAdapter implements VaultAdapter {
  textFiles = new Map<string, string>();
  binaryFiles = new Map<string, ArrayBuffer>();

  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.textFiles.has(p) || this.binaryFiles.has(p));
  }
  read(p: string): Promise<string> {
    const v = this.textFiles.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
  }
  write(p: string, c: string): Promise<void> {
    this.textFiles.set(p, c);
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(p: string, c: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(p, c);
    return Promise.resolve();
  }
  delete(p: string): Promise<void> {
    this.textFiles.delete(p);
    this.binaryFiles.delete(p);
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

// Helper: known base64 for the bytes 0xDE 0xAD 0xBE 0xEF.
const DEADBEEF_B64 = '3q2+7w==';

describe('base64ToArrayBuffer (pure)', () => {
  it('decodes a known short input', () => {
    const buf = base64ToArrayBuffer(DEADBEEF_B64);
    const view = new Uint8Array(buf);
    expect(Array.from(view)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('returns an empty buffer for empty input', () => {
    const buf = base64ToArrayBuffer('');
    expect(buf.byteLength).toBe(0);
  });

  it('throws on malformed base64', () => {
    expect(() => base64ToArrayBuffer('not~~base64')).toThrow();
  });
});

describe('file_asset', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('writes the binary file and records a delete-file inverse on accept', async () => {
    const gate = new AcceptAllGate();
    const tool = makeFileAssetTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      defaultFolder: 'attachments',
      now: () => 1700000000,
    });
    h.ctx.begin();
    const result = await tool.handler({
      filename: 'thing.bin',
      base64Content: DEADBEEF_B64,
    });

    expect(result).toEqual({
      status: 'applied',
      path: 'attachments/thing.bin',
      sizeBytes: 4,
    });
    const bytes = h.adapter.binaryFiles.get('attachments/thing.bin');
    expect(bytes).toBeDefined();
    expect(Array.from(new Uint8Array(bytes!))).toEqual([0xde, 0xad, 0xbe, 0xef]);

    const tx = await h.ctx.end();
    expect(tx?.ops[0].inverse).toEqual({
      kind: 'delete-file',
      path: 'attachments/thing.bin',
    });
  });

  it('emits a binary-file ProposalDiff with sizeBytes', async () => {
    const gate = new AcceptAllGate();
    const tool = makeFileAssetTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      defaultFolder: 'attachments',
    });
    h.ctx.begin();
    await tool.handler({ filename: 'a.bin', base64Content: DEADBEEF_B64 });

    expect(gate.seen[0].diff).toEqual({
      kind: 'binary-file',
      path: 'attachments/a.bin',
      sizeBytes: 4,
    });
  });

  it('uses the supplied folder when provided, overriding default', async () => {
    const gate = new AcceptAllGate();
    const tool = makeFileAssetTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      defaultFolder: 'attachments',
    });
    h.ctx.begin();
    await tool.handler({
      filename: 'photo.png',
      base64Content: DEADBEEF_B64,
      folder: '90-test/media',
    });

    expect(h.adapter.binaryFiles.has('90-test/media/photo.png')).toBe(true);
    expect(h.adapter.binaryFiles.has('attachments/photo.png')).toBe(false);
  });

  it("strips a trailing slash on `folder`", async () => {
    const gate = new AcceptAllGate();
    const tool = makeFileAssetTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      defaultFolder: 'attachments',
    });
    h.ctx.begin();
    await tool.handler({
      filename: 'x.bin',
      base64Content: DEADBEEF_B64,
      folder: 'sub/',
    });

    expect(h.adapter.binaryFiles.has('sub/x.bin')).toBe(true);
  });

  it('places at vault root when folder is empty string + default empty', async () => {
    const gate = new AcceptAllGate();
    const tool = makeFileAssetTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      defaultFolder: '',
    });
    h.ctx.begin();
    await tool.handler({ filename: 'rootfile.bin', base64Content: DEADBEEF_B64 });

    expect(h.adapter.binaryFiles.has('rootfile.bin')).toBe(true);
  });

  it("returns 'rejected' on user reject — no write happens", async () => {
    const gate = new RejectAllGate('not yet');
    const tool = makeFileAssetTool({
      adapter: h.adapter,
      gate,
      ctx: h.ctx,
      defaultFolder: 'attachments',
    });
    h.ctx.begin();
    const result = await tool.handler({
      filename: 'x.bin',
      base64Content: DEADBEEF_B64,
    });

    expect(result).toMatchObject({ status: 'rejected', reason: 'not yet' });
    expect(h.adapter.binaryFiles.has('attachments/x.bin')).toBe(false);
  });

  describe('error paths (proposal never goes to gate)', () => {
    it('errors when the target already exists', async () => {
      h.adapter.binaryFiles.set('attachments/x.bin', new ArrayBuffer(1));
      const gate = new AcceptAllGate();
      const tool = makeFileAssetTool({
        adapter: h.adapter,
        gate,
        ctx: h.ctx,
        defaultFolder: 'attachments',
      });
      h.ctx.begin();
      const result = await tool.handler({
        filename: 'x.bin',
        base64Content: DEADBEEF_B64,
      });
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/already exists/);
      expect(gate.seen).toHaveLength(0);
    });

    it('errors when folder escapes the vault', async () => {
      const gate = new AcceptAllGate();
      const tool = makeFileAssetTool({
        adapter: h.adapter,
        gate,
        ctx: h.ctx,
        defaultFolder: 'attachments',
      });
      h.ctx.begin();
      const result = await tool.handler({
        filename: 'evil.bin',
        base64Content: DEADBEEF_B64,
        folder: '../outside',
      });
      expect(result.status).toBe('error');
      expect(gate.seen).toHaveLength(0);
    });
  });

  describe('schema validation', () => {
    it("rejects filenames containing '/'", () => {
      const tool = makeFileAssetTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
        defaultFolder: 'attachments',
      });
      expect(
        tool.inputSchema.safeParse({
          filename: 'sub/x.bin',
          base64Content: DEADBEEF_B64,
        }).success,
      ).toBe(false);
    });

    it('rejects filenames starting with "."', () => {
      const tool = makeFileAssetTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
        defaultFolder: 'attachments',
      });
      expect(
        tool.inputSchema.safeParse({
          filename: '.hidden.bin',
          base64Content: DEADBEEF_B64,
        }).success,
      ).toBe(false);
    });

    it('rejects base64 strings that contain whitespace or data URL prefix', () => {
      const tool = makeFileAssetTool({
        adapter: h.adapter,
        gate: new AcceptAllGate(),
        ctx: h.ctx,
        defaultFolder: 'attachments',
      });
      expect(
        tool.inputSchema.safeParse({
          filename: 'x.bin',
          base64Content: 'data:image/png;base64,iVBORw0KG…',
        }).success,
      ).toBe(false);
      expect(
        tool.inputSchema.safeParse({
          filename: 'x.bin',
          base64Content: 'has\nnewline',
        }).success,
      ).toBe(false);
    });
  });
});
