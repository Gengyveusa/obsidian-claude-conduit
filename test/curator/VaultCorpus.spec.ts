import { describe, expect, it } from 'vitest';

import { VaultCorpus } from '../../src/curator/VaultCorpus';
import type {
  FileMetadata,
  MetadataCache,
  VaultAdapter,
  VaultStat,
} from '../../src/agent/types';

class FakeAdapter implements VaultAdapter {
  files = new Map<string, { content: string; mtimeSec: number; size: number }>();

  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const f = this.files.get(p);
    if (!f) {
      return Promise.reject(new Error(`ENOENT: ${p}`));
    }
    return Promise.resolve(f.content);
  }
  write(): Promise<void> {
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
    if (!f) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ mtime: f.mtimeSec, size: f.size });
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
}

class FakeMetadata implements MetadataCache {
  links = new Map<string, FileMetadata>();
  _resolved: Record<string, Record<string, number>> = {};

  get resolvedLinks(): Record<string, Record<string, number>> {
    return this._resolved;
  }

  getFileMetadata(p: string): FileMetadata | null {
    return this.links.get(p) ?? null;
  }

  resolveLink(): string | null {
    return null;
  }
}

describe('VaultCorpus', () => {
  it('listAllMarkdown delegates to the adapter', async () => {
    const a = new FakeAdapter();
    a.files.set('a.md', { content: '', mtimeSec: 0, size: 0 });
    a.files.set('b.md', { content: '', mtimeSec: 0, size: 0 });
    const c = new VaultCorpus(a, new FakeMetadata());
    expect(await c.listAllMarkdown()).toEqual(['a.md', 'b.md']);
  });

  it('read delegates to the adapter', async () => {
    const a = new FakeAdapter();
    a.files.set('a.md', { content: 'hello', mtimeSec: 0, size: 5 });
    const c = new VaultCorpus(a, new FakeMetadata());
    expect(await c.read('a.md')).toBe('hello');
  });

  it('stat converts mtime from seconds → milliseconds', async () => {
    const a = new FakeAdapter();
    // mtime as seconds (per VaultAdapter contract).
    a.files.set('a.md', { content: '', mtimeSec: 1_700_000_000, size: 42 });
    const c = new VaultCorpus(a, new FakeMetadata());
    const s = await c.stat('a.md');
    expect(s).not.toBeNull();
    if (s !== null) {
      expect(s.mtime).toBe(1_700_000_000_000);
      expect(s.ctime).toBe(1_700_000_000_000);
      expect(s.size).toBe(42);
    }
  });

  it('stat returns null for missing notes', async () => {
    const a = new FakeAdapter();
    const c = new VaultCorpus(a, new FakeMetadata());
    expect(await c.stat('nope.md')).toBeNull();
  });

  it('outboundLinks uses the metadata cache when present', async () => {
    const a = new FakeAdapter();
    a.files.set('a.md', { content: 'should not be parsed', mtimeSec: 0, size: 0 });
    const m = new FakeMetadata();
    m.links.set('a.md', {
      links: [{ link: 'X', line: 1 }, { link: 'Y', line: 3 }],
      frontmatter: null,
    });
    const c = new VaultCorpus(a, m);
    expect(await c.outboundLinks('a.md')).toEqual(['X', 'Y']);
  });

  it('outboundLinks falls back to parsing content when cache is empty', async () => {
    const a = new FakeAdapter();
    a.files.set('a.md', {
      content: 'links to [[Foo]] and [[Bar]]',
      mtimeSec: 0,
      size: 0,
    });
    const c = new VaultCorpus(a, new FakeMetadata());
    expect(await c.outboundLinks('a.md')).toEqual(['Foo', 'Bar']);
  });

  it('backlinks inverts the resolvedLinks map', async () => {
    const a = new FakeAdapter();
    const m = new FakeMetadata();
    m._resolved = {
      'src1.md': { 'target.md': 1 },
      'src2.md': { 'target.md': 2, 'other.md': 1 },
      'src3.md': { 'other.md': 1 },
    };
    const c = new VaultCorpus(a, m);
    expect((await c.backlinks('target.md')).sort()).toEqual(['src1.md', 'src2.md']);
    expect(await c.backlinks('other.md')).toEqual(expect.arrayContaining(['src2.md', 'src3.md']));
    expect(await c.backlinks('unreferenced.md')).toEqual([]);
  });
});
