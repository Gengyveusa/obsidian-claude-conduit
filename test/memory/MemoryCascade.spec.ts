import { describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  candidateCascadePaths,
  collectMemory,
  formatMemoryFooter,
  formatMemoryPromptText,
  MEMORY_FILENAME,
  TRUNCATION_MARKER,
} from '../../src/memory/MemoryCascade';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    return v === undefined
      ? Promise.reject(new Error(`ENOENT: ${path}`))
      : Promise.resolve(v);
  }
  write(): Promise<void> {
    throw new Error('unused');
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
    return Promise.resolve([...this.files.keys()]);
  }
}

describe('candidateCascadePaths', () => {
  it('returns root-only when no file is active', () => {
    expect(candidateCascadePaths(null)).toEqual(['CLAUDE.md']);
  });

  it('walks the ancestor chain root-first', () => {
    expect(
      candidateCascadePaths('30-Projects/sagittarius/notes/today.md'),
    ).toEqual([
      'CLAUDE.md',
      '30-Projects/CLAUDE.md',
      '30-Projects/sagittarius/CLAUDE.md',
      '30-Projects/sagittarius/notes/CLAUDE.md',
    ]);
  });

  it('handles a file directly at the vault root', () => {
    expect(candidateCascadePaths('inbox.md')).toEqual(['CLAUDE.md']);
  });

  it('strips a leading slash from absolute-looking paths', () => {
    expect(candidateCascadePaths('/foo/bar.md')).toEqual([
      'CLAUDE.md',
      'foo/CLAUDE.md',
    ]);
  });

  it('exports the filename as a stable constant', () => {
    expect(MEMORY_FILENAME).toBe('CLAUDE.md');
  });
});

describe('collectMemory', () => {
  it('loads only existing files in cascade order', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('CLAUDE.md', 'root rules');
    adapter.files.set('30-Projects/CLAUDE.md', 'project rules');
    // 30-Projects/sagittarius/CLAUDE.md intentionally missing
    const result = await collectMemory({
      adapter,
      activeFilePath: '30-Projects/sagittarius/notes/today.md',
      maxBytes: 50_000,
    });
    expect(result.sections.map((s) => s.path)).toEqual([
      'CLAUDE.md',
      '30-Projects/CLAUDE.md',
    ]);
    expect(result.totalBytes).toBe('root rules'.length + 'project rules'.length);
    expect(result.budgetHit).toBe(false);
  });

  it('returns empty when no CLAUDE.md files exist', async () => {
    const adapter = new MemAdapter();
    const result = await collectMemory({
      adapter,
      activeFilePath: '30-Projects/foo.md',
      maxBytes: 50_000,
    });
    expect(result.sections).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.budgetHit).toBe(false);
  });

  it('loads only root when no file is active', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('CLAUDE.md', 'root');
    adapter.files.set('30-Projects/CLAUDE.md', 'ignored');
    const result = await collectMemory({
      adapter,
      activeFilePath: null,
      maxBytes: 50_000,
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].path).toBe('CLAUDE.md');
  });

  it('skips zero-byte CLAUDE.md files', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('CLAUDE.md', '');
    adapter.files.set('30-Projects/CLAUDE.md', 'real content');
    const result = await collectMemory({
      adapter,
      activeFilePath: '30-Projects/foo.md',
      maxBytes: 50_000,
    });
    expect(result.sections.map((s) => s.path)).toEqual([
      '30-Projects/CLAUDE.md',
    ]);
  });

  it('soft-truncates the file that crosses the budget', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('CLAUDE.md', 'a'.repeat(60));
    adapter.files.set('30-Projects/CLAUDE.md', 'b'.repeat(60));
    const result = await collectMemory({
      adapter,
      activeFilePath: '30-Projects/foo.md',
      maxBytes: 100,
    });
    expect(result.budgetHit).toBe(true);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].truncated).toBe(false);
    expect(result.sections[0].text).toBe('a'.repeat(60));
    expect(result.sections[1].truncated).toBe(true);
    // Second section took 40 bytes of content + the marker.
    expect(result.sections[1].text).toBe('b'.repeat(40) + TRUNCATION_MARKER);
    expect(result.sections[1].sizeBytes).toBe(60); // original size, not truncated
  });

  it('skips remaining files after a truncation', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('CLAUDE.md', 'a'.repeat(100));
    adapter.files.set('30-Projects/CLAUDE.md', 'never read');
    const result = await collectMemory({
      adapter,
      activeFilePath: '30-Projects/foo.md',
      maxBytes: 50,
    });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].truncated).toBe(true);
    expect(result.budgetHit).toBe(true);
  });

  it('handles maxBytes=0 by returning empty + budgetHit', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('CLAUDE.md', 'something');
    const result = await collectMemory({
      adapter,
      activeFilePath: null,
      maxBytes: 0,
    });
    expect(result.sections).toEqual([]);
    expect(result.budgetHit).toBe(true);
  });
});

describe('formatMemoryPromptText', () => {
  it('returns null for an empty cascade', () => {
    expect(formatMemoryPromptText([])).toBeNull();
  });

  it('renders one section with a labeled header', () => {
    const out = formatMemoryPromptText([
      { path: 'CLAUDE.md', text: 'use snake_case', truncated: false, sizeBytes: 14 },
    ]);
    expect(out).toBe('# Memory: CLAUDE.md\n\nuse snake_case');
  });

  it('joins multiple sections with blank lines between them', () => {
    const out = formatMemoryPromptText([
      { path: 'CLAUDE.md', text: 'root', truncated: false, sizeBytes: 4 },
      { path: '30-Projects/CLAUDE.md', text: 'project', truncated: false, sizeBytes: 7 },
    ]);
    expect(out).toBe(
      '# Memory: CLAUDE.md\n\nroot\n\n# Memory: 30-Projects/CLAUDE.md\n\nproject',
    );
  });

  it('trims trailing whitespace from each section', () => {
    const out = formatMemoryPromptText([
      { path: 'CLAUDE.md', text: 'rules\n\n\n', truncated: false, sizeBytes: 8 },
    ]);
    expect(out).toBe('# Memory: CLAUDE.md\n\nrules');
  });
});

describe('formatMemoryFooter', () => {
  it("returns 'memory: none' for an empty cascade", () => {
    expect(formatMemoryFooter({ sections: [], totalBytes: 0, budgetHit: false })).toBe(
      'memory: none',
    );
  });

  it('reports bytes (in B for <1KB) + file paths', () => {
    const footer = formatMemoryFooter({
      sections: [
        { path: 'CLAUDE.md', text: 'x', truncated: false, sizeBytes: 1 },
      ],
      totalBytes: 500,
      budgetHit: false,
    });
    expect(footer).toBe('memory: 500B from CLAUDE.md');
  });

  it('reports KB (one decimal) for larger totals', () => {
    const footer = formatMemoryFooter({
      sections: [
        { path: 'CLAUDE.md', text: 'x', truncated: false, sizeBytes: 2148 },
      ],
      totalBytes: 2148,
      budgetHit: false,
    });
    expect(footer).toBe('memory: 2.1KB from CLAUDE.md');
  });

  it('appends a budget-hit marker when truncation happened', () => {
    const footer = formatMemoryFooter({
      sections: [
        { path: 'CLAUDE.md', text: 'x', truncated: true, sizeBytes: 100 },
      ],
      totalBytes: 100,
      budgetHit: true,
    });
    expect(footer).toBe('memory: 100B from CLAUDE.md (budget hit — truncated)');
  });

  it('joins multiple paths with comma-space', () => {
    const footer = formatMemoryFooter({
      sections: [
        { path: 'CLAUDE.md', text: 'x', truncated: false, sizeBytes: 1 },
        { path: '30-Projects/CLAUDE.md', text: 'y', truncated: false, sizeBytes: 1 },
      ],
      totalBytes: 2,
      budgetHit: false,
    });
    expect(footer).toBe('memory: 2B from CLAUDE.md, 30-Projects/CLAUDE.md');
  });
});
