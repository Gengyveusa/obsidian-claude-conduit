import { describe, expect, it, vi } from 'vitest';

import { VaultAdapterImpl } from '../../src/obsidian/VaultAdapterImpl';

/**
 * Minimal stub for `Obsidian.App` exposing only what `VaultAdapterImpl`
 * touches: `vault.adapter` (DataAdapter surface) + `vault.getMarkdownFiles()`.
 */
type StubInner = {
  exists: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  readBinary: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  writeBinary: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

function stubInner(overrides: Partial<StubInner> = {}): StubInner {
  return {
    exists: vi.fn(() => Promise.resolve(false)),
    read: vi.fn(() => Promise.resolve('')),
    readBinary: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
    write: vi.fn(() => Promise.resolve()),
    writeBinary: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve()),
    stat: vi.fn(() => Promise.resolve(null)),
    list: vi.fn(() => Promise.resolve({ files: [], folders: [] })),
    ...overrides,
  };
}

function buildAdapter(
  inner: StubInner,
  markdownPaths: string[] = [],
): VaultAdapterImpl {
  // Cast through `unknown` because the real Obsidian.App shape is enormous
  // and `VaultAdapterImpl` only reads `vault.adapter` and `vault.getMarkdownFiles`.
  const fakeApp = {
    vault: {
      adapter: inner,
      getMarkdownFiles: () => markdownPaths.map((p) => ({ path: p })),
    },
  } as unknown as ConstructorParameters<typeof VaultAdapterImpl>[0];
  return new VaultAdapterImpl(fakeApp);
}

describe('VaultAdapterImpl.write (v0.2.6 auto-mkdir contract per ADR-015)', () => {
  it('creates the parent dir before writing when parent does not exist', async () => {
    const inner = stubInner({
      exists: vi.fn(() => Promise.resolve(false)),
    });
    const adapter = buildAdapter(inner);

    await adapter.write('70-Memory/conversations/2026-05-10/abc.md', 'hi');

    expect(inner.mkdir).toHaveBeenCalledTimes(1);
    expect(inner.mkdir).toHaveBeenCalledWith('70-Memory/conversations/2026-05-10');
    expect(inner.write).toHaveBeenCalledWith('70-Memory/conversations/2026-05-10/abc.md', 'hi');
    // mkdir must come before write
    const mkdirOrder = inner.mkdir.mock.invocationCallOrder[0];
    const writeOrder = inner.write.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  it('skips mkdir when the parent dir already exists', async () => {
    const inner = stubInner({
      exists: vi.fn(() => Promise.resolve(true)),
    });
    const adapter = buildAdapter(inner);

    await adapter.write('70-Memory/x.md', 'hi');

    expect(inner.mkdir).not.toHaveBeenCalled();
    expect(inner.write).toHaveBeenCalledWith('70-Memory/x.md', 'hi');
  });

  it('skips mkdir entirely for root-level writes (no slash in path)', async () => {
    const inner = stubInner();
    const adapter = buildAdapter(inner);

    await adapter.write('README.md', 'hi');

    expect(inner.exists).not.toHaveBeenCalled();
    expect(inner.mkdir).not.toHaveBeenCalled();
    expect(inner.write).toHaveBeenCalledWith('README.md', 'hi');
  });

  it('handles deep nested paths (multi-level mkdir is recursive per ADR-015)', async () => {
    const inner = stubInner({
      exists: vi.fn(() => Promise.resolve(false)),
    });
    const adapter = buildAdapter(inner);

    await adapter.write('a/b/c/d/e.md', 'hi');

    expect(inner.mkdir).toHaveBeenCalledTimes(1);
    expect(inner.mkdir).toHaveBeenCalledWith('a/b/c/d');
  });

  it('writeBinary follows the same auto-mkdir contract', async () => {
    const inner = stubInner({
      exists: vi.fn(() => Promise.resolve(false)),
    });
    const adapter = buildAdapter(inner);
    const buf = new ArrayBuffer(8);

    await adapter.writeBinary('.obsidian/plugins/obsidian-claude-conduit/index.sqlite', buf);

    expect(inner.mkdir).toHaveBeenCalledWith('.obsidian/plugins/obsidian-claude-conduit');
    expect(inner.writeBinary).toHaveBeenCalledWith(
      '.obsidian/plugins/obsidian-claude-conduit/index.sqlite',
      buf,
    );
  });
});

describe('VaultAdapterImpl pass-through methods', () => {
  it('listAllMarkdown maps app.vault.getMarkdownFiles() to paths', async () => {
    const adapter = buildAdapter(stubInner(), ['a.md', 'sub/b.md', 'c.md']);
    const out = await adapter.listAllMarkdown();
    expect(out).toEqual(['a.md', 'sub/b.md', 'c.md']);
  });

  it('stat converts Obsidian ms mtime to contract epoch seconds', async () => {
    const inner = stubInner({
      stat: vi.fn(() => Promise.resolve({ type: 'file', ctime: 0, mtime: 12345000, size: 42 })),
    });
    const adapter = buildAdapter(inner);

    const stat = await adapter.stat('x.md');
    expect(stat).toEqual({ mtime: 12345, size: 42 });
  });

  it('stat returns null for missing paths', async () => {
    const inner = stubInner({ stat: vi.fn(() => Promise.resolve(null)) });
    const adapter = buildAdapter(inner);
    expect(await adapter.stat('does-not-exist.md')).toBeNull();
  });

  it('mkdir is a no-op when the folder already exists', async () => {
    const inner = stubInner({ exists: vi.fn(() => Promise.resolve(true)) });
    const adapter = buildAdapter(inner);

    await adapter.mkdir('70-Memory');
    expect(inner.mkdir).not.toHaveBeenCalled();
  });

  it('mkdir delegates when the folder is missing', async () => {
    const inner = stubInner({ exists: vi.fn(() => Promise.resolve(false)) });
    const adapter = buildAdapter(inner);

    await adapter.mkdir('70-Memory');
    expect(inner.mkdir).toHaveBeenCalledWith('70-Memory');
  });
});
