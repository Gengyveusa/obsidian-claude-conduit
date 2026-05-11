import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/agent/ToolRegistry';
import { makeReadNoteTool } from '../../../src/agent/tools/read_note';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';

interface FakeFile {
  content: string;
  stat: VaultStat;
}

class FakeVaultAdapter implements VaultAdapter {
  constructor(private readonly files: Map<string, FakeFile>) {}

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  read(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`FakeVaultAdapter.read: ${path} not found`);
    }
    return Promise.resolve(file.content);
  }

  readBinary(_path: string): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  write(_path: string, _content: string): Promise<void> {
    return Promise.resolve();
  }

  writeBinary(_path: string, _content: ArrayBuffer): Promise<void> {
    return Promise.resolve();
  }

  mkdir(_path: string): Promise<void> {
    return Promise.resolve();
  }

  stat(path: string): Promise<VaultStat | null> {
    return Promise.resolve(this.files.get(path)?.stat ?? null);
  }

  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [...this.files.keys()], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

function adapterWith(files: Record<string, FakeFile>): VaultAdapter {
  return new FakeVaultAdapter(new Map(Object.entries(files)));
}

describe('read_note', () => {
  it('returns frontmatter + body + mtime + size for an existing note', async () => {
    const adapter = adapterWith({
      'a.md': {
        content:
          '---\ntitle: Hello\ntags: [demo]\n---\nThis is the body.\n\nSecond paragraph.',
        stat: { mtime: 1715000000.5, size: 60 },
      },
    });
    const tool = makeReadNoteTool(adapter);
    const out = await tool.handler({ path: 'a.md' });
    expect(out).not.toBeNull();
    expect(out?.path).toBe('a.md');
    expect(out?.frontmatter).toEqual({ title: 'Hello', tags: ['demo'] });
    expect(out?.body).toBe('This is the body.\n\nSecond paragraph.');
    expect(out?.mtime).toBe(1715000000.5);
    expect(out?.size_bytes).toBe(60);
    // v0.3.x: hash is the SHA-256 of the raw on-disk content (frontmatter + body).
    // Phase 4 write tools use it as `expectedHash` for ConflictDetector.
    expect(out?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when the note does not exist', async () => {
    const adapter = adapterWith({});
    const tool = makeReadNoteTool(adapter);
    const out = await tool.handler({ path: 'missing.md' });
    expect(out).toBeNull();
  });

  it('handles notes with no frontmatter (returns null frontmatter, full body)', async () => {
    const adapter = adapterWith({
      'plain.md': {
        content: 'Just a body. No yaml here.',
        stat: { mtime: 1, size: 26 },
      },
    });
    const tool = makeReadNoteTool(adapter);
    const out = await tool.handler({ path: 'plain.md' });
    expect(out?.frontmatter).toBeNull();
    expect(out?.body).toBe('Just a body. No yaml here.');
  });

  it('treats malformed YAML as null frontmatter and preserves the raw body', async () => {
    const adapter = adapterWith({
      'broken.md': {
        // Unclosed bracket → yaml parse throws
        content: '---\ntags: [unclosed\n---\nBody survives.',
        stat: { mtime: 1, size: 38 },
      },
    });
    const tool = makeReadNoteTool(adapter);
    const out = await tool.handler({ path: 'broken.md' });
    expect(out?.frontmatter).toBeNull();
    // Raw content preserved (frontmatter delimiters included) so the agent
    // can still see what was there.
    expect(out?.body).toContain('---');
  });

  it('rejects path containing ".." via Zod (path-traversal defense)', async () => {
    const adapter = adapterWith({});
    const tool = makeReadNoteTool(adapter);
    const reg = new ToolRegistry();
    reg.register(tool);
    await expect(reg.execute('read_note', { path: '../../../etc/passwd' })).rejects.toThrow(
      /must not contain "\.\." segments/,
    );
  });

  it('rejects absolute paths via Zod', async () => {
    const adapter = adapterWith({});
    const tool = makeReadNoteTool(adapter);
    const reg = new ToolRegistry();
    reg.register(tool);
    await expect(reg.execute('read_note', { path: '/etc/passwd' })).rejects.toThrow(
      /vault-relative \(no leading slash\)/,
    );
  });

  it('rejects empty path via Zod', async () => {
    const tool = makeReadNoteTool(adapterWith({}));
    const reg = new ToolRegistry();
    reg.register(tool);
    await expect(reg.execute('read_note', { path: '' })).rejects.toThrow(/non-empty/);
  });

  it('integrates with ToolRegistry: schemas() lists read_note', () => {
    const reg = new ToolRegistry();
    reg.register(makeReadNoteTool(adapterWith({})));
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('read_note');
    expect(schemas[0].description).toContain('frontmatter and body');
  });
});
