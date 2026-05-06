import { describe, expect, it } from 'vitest';

import { makeListFolderTool } from '../../../src/agent/tools/list_folder';
import type { VaultAdapter, VaultStat } from '../../../src/agent/types';

interface FakeFile {
  stat: VaultStat;
}

class FakeVaultAdapter implements VaultAdapter {
  constructor(
    private readonly tree: {
      files: Map<string, FakeFile>;
      folders: Map<string, { files: string[]; folders: string[] }>;
    },
  ) {}

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.tree.files.has(path) || this.tree.folders.has(path));
  }

  read(_path: string): Promise<string> {
    return Promise.resolve('');
  }

  stat(path: string): Promise<VaultStat | null> {
    return Promise.resolve(this.tree.files.get(path)?.stat ?? null);
  }

  list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve(this.tree.folders.get(folder) ?? { files: [], folders: [] });
  }
}

function buildTree(spec: Record<string, { files?: string[]; folders?: string[] }>): VaultAdapter {
  const folders = new Map<string, { files: string[]; folders: string[] }>();
  const files = new Map<string, FakeFile>();
  for (const [folderPath, contents] of Object.entries(spec)) {
    folders.set(folderPath, {
      files: contents.files ?? [],
      folders: contents.folders ?? [],
    });
    for (const f of contents.files ?? []) {
      files.set(f, { stat: { mtime: 1, size: 100 } });
    }
  }
  return new FakeVaultAdapter({ files, folders });
}

describe('list_folder', () => {
  it('returns markdown notes + immediate subfolders for non-recursive list', async () => {
    const adapter = buildTree({
      '50-FortressFlow': {
        files: ['50-FortressFlow/Pipeline_State.md', '50-FortressFlow/Sweep_Log.md'],
        folders: ['50-FortressFlow/Partnerships'],
      },
    });
    const tool = makeListFolderTool(adapter);
    const out = await tool.handler({ path: '50-FortressFlow', recursive: false });

    expect(out.folder).toBe('50-FortressFlow');
    expect(out.notes.map((n) => n.path)).toEqual([
      '50-FortressFlow/Pipeline_State.md',
      '50-FortressFlow/Sweep_Log.md',
    ]);
    expect(out.subfolders).toEqual(['50-FortressFlow/Partnerships']);
  });

  it('walks the subtree when recursive=true', async () => {
    const adapter = buildTree({
      'docs': {
        files: ['docs/intro.md'],
        folders: ['docs/guide'],
      },
      'docs/guide': {
        files: ['docs/guide/step1.md', 'docs/guide/step2.md'],
        folders: [],
      },
    });
    const tool = makeListFolderTool(adapter);
    const out = await tool.handler({ path: 'docs', recursive: true });
    expect(out.notes.map((n) => n.path)).toEqual([
      'docs/guide/step1.md',
      'docs/guide/step2.md',
      'docs/intro.md',
    ]);
  });

  it('skips non-md files', async () => {
    const adapter = buildTree({
      'mixed': {
        files: ['mixed/note.md', 'mixed/image.png', 'mixed/data.csv'],
        folders: [],
      },
    });
    const tool = makeListFolderTool(adapter);
    const out = await tool.handler({ path: 'mixed', recursive: false });
    expect(out.notes.map((n) => n.path)).toEqual(['mixed/note.md']);
  });

  it('rejects path traversal at the schema boundary', () => {
    const tool = makeListFolderTool(buildTree({}));
    const result = tool.inputSchema.safeParse({ path: '../escape', recursive: false });
    expect(result.success).toBe(false);
  });
});
