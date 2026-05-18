import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { extractFromMarkdown, extractOpenThreads } from '../../src/briefing/journalThreads';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(v);
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

describe('extractFromMarkdown', () => {
  it('extracts a single Open threads bullet from one H2 section', () => {
    const journal = [
      '## 2026-05-15 22:14 — Planning',
      '',
      '- **Worked on:** drafting',
      '- **Decided:** ship MVP',
      '- **Learned about operator:** prefers tight planning ADRs',
      '- **Open threads:** v1.4.2 tag/release pending',
    ].join('\n');
    expect(extractFromMarkdown(journal)).toEqual(['v1.4.2 tag/release pending']);
  });

  it('extracts one thread per H2 section', () => {
    const journal = [
      '## Session A',
      '- **Open threads:** thread A',
      '',
      '## Session B',
      '- **Open threads:** thread B',
    ].join('\n');
    expect(extractFromMarkdown(journal)).toEqual(['thread A', 'thread B']);
  });

  it('skips "none" and "(not specified)" placeholders', () => {
    const journal = [
      '## A',
      '- **Open threads:** real thread',
      '',
      '## B',
      '- **Open threads:** none',
      '',
      '## C',
      '- **Open threads:** (not specified)',
      '',
      '## D',
      '- **Open threads:** None.',
    ].join('\n');
    expect(extractFromMarkdown(journal)).toEqual(['real thread']);
  });

  it('tolerates underscore + asterisk emphasis variations on the label', () => {
    expect(extractFromMarkdown('## A\n- _Open threads:_ underscored value')).toEqual([
      'underscored value',
    ]);
    expect(extractFromMarkdown('## A\n- Open threads: bare label')).toEqual(['bare label']);
  });

  it('returns empty when the H2 has no Open threads bullet', () => {
    const journal = [
      '## Session',
      '- **Worked on:** x',
      '- **Decided:** y',
    ].join('\n');
    expect(extractFromMarkdown(journal)).toEqual([]);
  });
});

describe('extractOpenThreads', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
  });

  it('returns empty when limit is 0', async () => {
    adapter.files.set('_memory/2026-05-15.md', '## A\n- **Open threads:** thread');
    expect(await extractOpenThreads(adapter, 0)).toEqual([]);
  });

  it('returns empty when no journals exist', async () => {
    expect(await extractOpenThreads(adapter, 3)).toEqual([]);
  });

  it('reads from the most-recent journals, newest-first', async () => {
    adapter.files.set('_memory/2026-05-13.md', '## A\n- **Open threads:** oldest');
    adapter.files.set('_memory/2026-05-14.md', '## A\n- **Open threads:** middle');
    adapter.files.set('_memory/2026-05-15.md', '## A\n- **Open threads:** newest');
    const threads = await extractOpenThreads(adapter, 2);
    expect(threads).toEqual(['newest', 'middle']);
  });

  it('aggregates multiple H2 sections within each file', async () => {
    adapter.files.set(
      '_memory/2026-05-15.md',
      [
        '## A',
        '- **Open threads:** thread A',
        '',
        '## B',
        '- **Open threads:** thread B',
      ].join('\n'),
    );
    expect(await extractOpenThreads(adapter, 5)).toEqual(['thread A', 'thread B']);
  });
});
