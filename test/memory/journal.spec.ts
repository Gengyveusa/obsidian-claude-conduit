import { describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  formatJournalCascade,
  formatJournalSection,
  isJournalPath,
  JOURNAL_ROOT,
  journalPathFor,
  listRecentJournals,
} from '../../src/memory/journal';

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

describe('journalPathFor', () => {
  it('computes a YYYY-MM-DD.md path under _memory/', () => {
    const date = new Date('2026-05-15T22:30:00-07:00');
    expect(journalPathFor(date, 'America/Los_Angeles')).toBe('_memory/2026-05-15.md');
  });

  it("respects the operator's timezone (midnight crossing)", () => {
    // 2026-05-16 03:00 UTC = 2026-05-15 23:00 in Los Angeles.
    const date = new Date('2026-05-16T03:00:00Z');
    expect(journalPathFor(date, 'America/Los_Angeles')).toBe('_memory/2026-05-15.md');
    expect(journalPathFor(date, 'UTC')).toBe('_memory/2026-05-16.md');
  });
});

describe('isJournalPath', () => {
  it('accepts canonical journal paths', () => {
    expect(isJournalPath('_memory/2026-05-15.md')).toBe(true);
    expect(isJournalPath('_memory/2024-01-01.md')).toBe(true);
  });

  it('rejects non-_memory paths', () => {
    expect(isJournalPath('10-Inbox/2026-05-15.md')).toBe(false);
    expect(isJournalPath('memory/2026-05-15.md')).toBe(false); // missing underscore
  });

  it('rejects _archive/ subfolder', () => {
    expect(isJournalPath('_memory/_archive/2025-12-01.md')).toBe(false);
  });

  it('rejects malformed filenames', () => {
    expect(isJournalPath('_memory/notes.md')).toBe(false);
    expect(isJournalPath('_memory/2026-5-15.md')).toBe(false); // missing zero-pad
    expect(isJournalPath('_memory/2026-05-15.txt')).toBe(false);
  });

  it('exports the root prefix as a stable constant', () => {
    expect(JOURNAL_ROOT).toBe('_memory/');
  });
});

describe('formatJournalSection', () => {
  it('renders the four-bullet H2 block per ADR-033 D3', () => {
    const date = new Date('2026-05-15T22:14:00-07:00');
    const out = formatJournalSection(
      date,
      'Phase 12 planning',
      {
        workedOn: 'drafted ADR-033',
        decided: 'ship MVP operator-triggered',
        learnedAboutOperator: 'prefers tight planning ADRs',
        openThreads: 'v1.4.2 tag/release',
      },
      'America/Los_Angeles',
    );
    expect(out).toMatch(/^## 2026-05-15 22:14 — Phase 12 planning/);
    expect(out).toContain('- **Worked on:** drafted ADR-033');
    expect(out).toContain('- **Decided:** ship MVP operator-triggered');
    expect(out).toContain('- **Learned about operator:** prefers tight planning ADRs');
    expect(out).toContain('- **Open threads:** v1.4.2 tag/release');
  });

  it('collapses newlines inside bullets to keep each on one line', () => {
    const date = new Date('2026-05-15T12:00:00Z');
    const out = formatJournalSection(
      date,
      'x',
      {
        workedOn: 'multi\nline\ntext',
        decided: '  whitespace  ',
        learnedAboutOperator: 'a',
        openThreads: 'b',
      },
      'UTC',
    );
    expect(out).toContain('- **Worked on:** multi line text');
    expect(out).toContain('- **Decided:** whitespace');
  });
});

describe('listRecentJournals', () => {
  it('returns the N most-recent journal files newest-first', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('_memory/2026-05-13.md', 'a');
    adapter.files.set('_memory/2026-05-14.md', 'b');
    adapter.files.set('_memory/2026-05-15.md', 'c');
    adapter.files.set('10-Inbox/note.md', 'unrelated');
    const result = await listRecentJournals(adapter, 2);
    expect(result).toEqual(['_memory/2026-05-15.md', '_memory/2026-05-14.md']);
  });

  it('returns all journals when N exceeds the count', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('_memory/2026-05-15.md', 'x');
    const result = await listRecentJournals(adapter, 10);
    expect(result).toHaveLength(1);
  });

  it('returns empty for N=0', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('_memory/2026-05-15.md', 'x');
    expect(await listRecentJournals(adapter, 0)).toEqual([]);
  });

  it('skips _archive/ files', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('_memory/2026-05-15.md', 'a');
    adapter.files.set('_memory/_archive/2025-01-01.md', 'b');
    const result = await listRecentJournals(adapter, 10);
    expect(result).toEqual(['_memory/2026-05-15.md']);
  });
});

describe('formatJournalCascade', () => {
  it('renders a labeled section with each journal under its date heading', async () => {
    const adapter = new MemAdapter();
    adapter.files.set(
      '_memory/2026-05-15.md',
      '## 22:14 — recent\n\n- **Worked on:** x',
    );
    adapter.files.set(
      '_memory/2026-05-14.md',
      '## 09:00 — older\n\n- **Worked on:** y',
    );
    const text = await formatJournalCascade(adapter, 3);
    expect(text).not.toBeNull();
    expect(text).toContain('# Memory: recent session journals (most recent first)');
    // Date headings appear newest-first.
    const idx15 = text!.indexOf('## 2026-05-15');
    const idx14 = text!.indexOf('## 2026-05-14');
    expect(idx15).toBeGreaterThanOrEqual(0);
    expect(idx14).toBeGreaterThan(idx15);
  });

  it('returns null when no journals exist', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('10-Inbox/x.md', 'unrelated');
    expect(await formatJournalCascade(adapter, 3)).toBeNull();
  });

  it('returns null when limit is 0 (journaling disabled in cascade)', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('_memory/2026-05-15.md', 'x');
    expect(await formatJournalCascade(adapter, 0)).toBeNull();
  });

  it('skips empty journal files', async () => {
    const adapter = new MemAdapter();
    adapter.files.set('_memory/2026-05-15.md', '');
    adapter.files.set('_memory/2026-05-14.md', 'content');
    const text = await formatJournalCascade(adapter, 3);
    expect(text).toContain('2026-05-14');
    expect(text).not.toContain('2026-05-15');
  });
});
