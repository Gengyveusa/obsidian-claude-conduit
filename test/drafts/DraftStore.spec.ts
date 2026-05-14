import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import { DraftStore } from '../../src/drafts/DraftStore';

/**
 * In-memory `VaultAdapter` — only the methods `DraftStore` calls
 * (`listAllMarkdown`, `read`) need real behavior.
 */
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

function draftFile(
  topic: string,
  generatedAt: number,
  model = 'claude-opus-4-7',
  citedChunks: ReadonlyArray<{ note: string; chunk: number; score: number }> = [],
  body = '# Heading\n\nBody.',
): string {
  const chunkLines =
    citedChunks.length === 0
      ? 'cited_chunks: []'
      : `cited_chunks:\n${citedChunks
          .map(
            (c) =>
              `  - { note: '${c.note}', chunk: ${c.chunk}, score: ${c.score} }`,
          )
          .join('\n')}`;
  return [
    '---',
    `topic: '${topic}'`,
    `drafting_model: ${model}`,
    `generated_at: ${generatedAt}`,
    'quarantine: true',
    chunkLines,
    '---',
    '',
    body,
  ].join('\n');
}

describe('DraftStore', () => {
  let adapter: MemAdapter;
  let store: DraftStore;

  beforeEach(() => {
    adapter = new MemAdapter();
    store = new DraftStore({ adapter });
  });

  it('lists drafts only from under _drafts/', async () => {
    adapter.files.set('_drafts/10-Inbox/a.md', draftFile('A', 1700000000));
    adapter.files.set('_drafts/30-Projects/b.md', draftFile('B', 1700001000));
    adapter.files.set('10-Inbox/not-a-draft.md', '# Real note');
    adapter.files.set('20-Notes/also-not.md', 'plain content');
    const list = await store.list();
    expect(list.map((d) => d.path)).toEqual([
      '_drafts/30-Projects/b.md',
      '_drafts/10-Inbox/a.md',
    ]);
  });

  it('sorts newest-first by generated_at', async () => {
    adapter.files.set('_drafts/a.md', draftFile('A', 1700000000));
    adapter.files.set('_drafts/b.md', draftFile('B', 1700001000));
    adapter.files.set('_drafts/c.md', draftFile('C', 1700002000));
    const list = await store.list();
    expect(list.map((d) => d.topic)).toEqual(['C', 'B', 'A']);
  });

  it('places records without generatedAt at the end, alphabetic by path', async () => {
    adapter.files.set('_drafts/a.md', draftFile('A', 1700000000));
    adapter.files.set('_drafts/z-no-meta.md', '# No frontmatter');
    adapter.files.set('_drafts/m-no-meta.md', '# Also no frontmatter');
    const list = await store.list();
    expect(list.map((d) => d.path)).toEqual([
      '_drafts/a.md',
      '_drafts/m-no-meta.md',
      '_drafts/z-no-meta.md',
    ]);
  });

  it('parses topic + drafting_model + generated_at + cited_chunks count', async () => {
    adapter.files.set(
      '_drafts/x.md',
      draftFile('Q3 synthesis', 1_700_000_000, 'claude-sonnet-4-6', [
        { note: 'a.md', chunk: 0, score: 0.9 },
        { note: 'b.md', chunk: 1, score: 0.8 },
      ]),
    );
    const [rec] = await store.list();
    expect(rec.topic).toBe('Q3 synthesis');
    expect(rec.draftingModel).toBe('claude-sonnet-4-6');
    expect(rec.generatedAt).toBe(1_700_000_000);
    expect(rec.citedChunksCount).toBe(2);
  });

  it('tolerates malformed frontmatter — fields degrade to null/0', async () => {
    adapter.files.set('_drafts/broken.md', '---\nnot: valid yaml: at all: :::\n---\n# Body');
    const [rec] = await store.list();
    expect(rec.topic).toBeNull();
    expect(rec.generatedAt).toBeNull();
    expect(rec.draftingModel).toBeNull();
    expect(rec.citedChunksCount).toBe(0);
  });

  it('falls back to first heading when topic is missing', async () => {
    adapter.files.set('_drafts/no-topic.md', '# Recovered title\n\nBody.');
    const [rec] = await store.list();
    expect(rec.topic).toBeNull();
    expect(rec.firstHeading).toBe('Recovered title');
  });

  it("returns firstHeading=null when the body doesn't start with a heading", async () => {
    adapter.files.set('_drafts/x.md', '---\ntopic: t\n---\n\nNo heading.\n\n# Late heading.');
    const [rec] = await store.list();
    expect(rec.firstHeading).toBeNull();
  });

  it('size() returns the count without parsing frontmatter', async () => {
    adapter.files.set('_drafts/a.md', '# anything');
    adapter.files.set('_drafts/b.md', '# anything');
    adapter.files.set('not-a-draft.md', 'x');
    expect(await store.size()).toBe(2);
  });

  it('returns an empty list when no drafts exist', async () => {
    adapter.files.set('10-Inbox/foo.md', '# Real');
    expect(await store.list()).toEqual([]);
    expect(await store.size()).toBe(0);
  });

  it('loadRecord throws for non-draft paths', async () => {
    adapter.files.set('10-Inbox/x.md', '# Real');
    await expect(store.loadRecord('10-Inbox/x.md')).rejects.toThrow(/not under _drafts/);
  });
});
