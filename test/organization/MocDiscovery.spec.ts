import { describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { MocDiscovery } from '../../src/organization/MocDiscovery';

/** In-memory `VaultAdapter` used by tests. */
class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  markdownPaths: string[] = [];

  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const v = this.files.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
  }
  write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
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
  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve(this.markdownPaths);
  }
}

const MOC = `# Decisions

- [[ADR-001]]
- [[ADR-002]]
- [[ADR-003]]`;

const NOT_MOC = `# Meeting Notes

Met with Sarah about pipeline. We touched on [[Soltura]] briefly but
didn't dig in. Action items go in the usual place.`;

describe('MocDiscovery', () => {
  it('returns [] when no folders are configured (no I/O)', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = ['22-Decisions/00_Index.md'];
    adapter.files.set('22-Decisions/00_Index.md', MOC);

    const discovery = new MocDiscovery({ adapter, mocFolders: [] });
    expect(await discovery.discover()).toEqual([]);
  });

  it('returns [] when configured folders contain no MOC-shaped notes', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = ['22-Decisions/random.md'];
    adapter.files.set('22-Decisions/random.md', NOT_MOC);

    const discovery = new MocDiscovery({
      adapter,
      mocFolders: ['22-Decisions/'],
    });
    expect(await discovery.discover()).toEqual([]);
  });

  it('finds MOC notes inside configured folders', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = [
      '22-Decisions/00_Index.md',
      '22-Decisions/other.md',
      '70-Memory/elsewhere.md',
    ];
    adapter.files.set('22-Decisions/00_Index.md', MOC);
    adapter.files.set('22-Decisions/other.md', NOT_MOC);
    adapter.files.set('70-Memory/elsewhere.md', MOC); // outside watched

    const discovery = new MocDiscovery({
      adapter,
      mocFolders: ['22-Decisions/'],
    });
    const results = await discovery.discover();

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('22-Decisions/00_Index.md');
    expect(results[0].basename).toBe('00_Index');
    expect(results[0].firstHeading).toBe('Decisions');
    expect(results[0].wikilinkBulletCount).toBe(3);
  });

  it('respects multiple configured folders', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = [
      '22-Decisions/00_Index.md',
      '30-Gengyve-GTM/MOC.md',
      '70-Memory/foo.md',
    ];
    adapter.files.set('22-Decisions/00_Index.md', MOC);
    adapter.files.set('30-Gengyve-GTM/MOC.md', MOC);
    adapter.files.set('70-Memory/foo.md', MOC);

    const discovery = new MocDiscovery({
      adapter,
      mocFolders: ['22-Decisions/', '30-Gengyve-GTM/'],
    });
    const results = await discovery.discover();

    expect(results.map((r) => r.path).sort()).toEqual([
      '22-Decisions/00_Index.md',
      '30-Gengyve-GTM/MOC.md',
    ]);
  });

  it('strips trailing slashes from configured folders consistently', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = ['22-Decisions/index.md'];
    adapter.files.set('22-Decisions/index.md', MOC);

    const discovery = new MocDiscovery({
      adapter,
      mocFolders: ['22-Decisions'], // no trailing slash
    });
    const results = await discovery.discover();
    expect(results).toHaveLength(1);
  });

  it('sorts results by wikilinkBulletCount descending', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = [
      '22-Decisions/small.md',
      '22-Decisions/big.md',
      '22-Decisions/medium.md',
    ];
    adapter.files.set(
      '22-Decisions/small.md',
      `# Small\n- [[a]]\n- [[b]]\n- [[c]]`,
    );
    adapter.files.set(
      '22-Decisions/big.md',
      `# Big\n- [[a]]\n- [[b]]\n- [[c]]\n- [[d]]\n- [[e]]\n- [[f]]\n- [[g]]`,
    );
    adapter.files.set(
      '22-Decisions/medium.md',
      `# Medium\n- [[a]]\n- [[b]]\n- [[c]]\n- [[d]]`,
    );

    const discovery = new MocDiscovery({
      adapter,
      mocFolders: ['22-Decisions/'],
    });
    const results = await discovery.discover();

    expect(results.map((r) => r.basename)).toEqual(['big', 'medium', 'small']);
  });

  it('silently skips files that fail to read', async () => {
    const adapter = new MemAdapter();
    adapter.markdownPaths = ['22-Decisions/good.md', '22-Decisions/bad.md'];
    adapter.files.set('22-Decisions/good.md', MOC);
    // No file content for bad.md → read() rejects.

    const discovery = new MocDiscovery({
      adapter,
      mocFolders: ['22-Decisions/'],
    });
    const results = await discovery.discover();
    expect(results.map((r) => r.basename)).toEqual(['good']);
  });
});
