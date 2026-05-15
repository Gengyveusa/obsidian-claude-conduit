import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  formatDriftSummary,
  verifyCitations,
  type CitationDriftReport,
} from '../../src/drafts/citationDrift';
import type { Chunk } from '../../src/retrieval/types';
import type { SqliteEngine } from '../../src/retrieval/SqliteEngine';

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

/**
 * In-memory `SqliteEngine` stub — only the two methods `verifyCitations`
 * calls (`getChunk`, `countChunksForPath`) need real behavior.
 */
class FakeEngine {
  // notePath -> chunkIndex -> Chunk
  private store = new Map<string, Map<number, Chunk>>();

  add(notePath: string, chunkIndex: number): void {
    let inner = this.store.get(notePath);
    if (inner === undefined) {
      inner = new Map();
      this.store.set(notePath, inner);
    }
    inner.set(chunkIndex, {
      notePath,
      chunkIndex,
      text: 'x',
      embedding: new Float32Array([1, 0, 0]),
    });
  }

  getChunk(notePath: string, chunkIndex: number): Chunk | null {
    return this.store.get(notePath)?.get(chunkIndex) ?? null;
  }

  countChunksForPath(notePath: string): number {
    return this.store.get(notePath)?.size ?? 0;
  }
}

function draftWithCitations(
  rows: ReadonlyArray<{ note: string; chunk: number; score?: number }>,
): string {
  const lines = ['---', "topic: 'x'", 'drafting_model: claude-opus-4-7', 'generated_at: 1', 'quarantine: true'];
  if (rows.length === 0) {
    lines.push('cited_chunks: []');
  } else {
    lines.push('cited_chunks:');
    for (const r of rows) {
      lines.push(`  - { note: '${r.note}', chunk: ${r.chunk}, score: ${r.score ?? 0.5} }`);
    }
  }
  lines.push('---', '', '# Body', '', 'content');
  return lines.join('\n');
}

describe('verifyCitations', () => {
  let adapter: MemAdapter;
  let selfEngine: FakeEngine;

  beforeEach(() => {
    adapter = new MemAdapter();
    selfEngine = new FakeEngine();
  });

  it('returns no drift when every cited chunk resolves in self engine', async () => {
    selfEngine.add('10-Inbox/a.md', 0);
    selfEngine.add('10-Inbox/a.md', 1);
    adapter.files.set(
      '_drafts/x.md',
      draftWithCitations([
        { note: '10-Inbox/a.md', chunk: 0 },
        { note: '10-Inbox/a.md', chunk: 1 },
      ]),
    );
    const report = await verifyCitations({
      adapter,
      draftPath: '_drafts/x.md',
      selfEngine: selfEngine as unknown as SqliteEngine,
    });
    expect(report).toEqual({
      total: 2,
      verified: 2,
      missingChunks: [],
      missingNotes: [],
      hasDrift: false,
    });
  });

  it('classifies a chunk-index gone (note rechunked) as missingChunks', async () => {
    // Note exists with chunks 0,1 but the draft cited chunk 5 (out of range).
    selfEngine.add('10-Inbox/a.md', 0);
    selfEngine.add('10-Inbox/a.md', 1);
    adapter.files.set(
      '_drafts/x.md',
      draftWithCitations([{ note: '10-Inbox/a.md', chunk: 5 }]),
    );
    const report = await verifyCitations({
      adapter,
      draftPath: '_drafts/x.md',
      selfEngine: selfEngine as unknown as SqliteEngine,
    });
    expect(report.hasDrift).toBe(true);
    expect(report.missingChunks).toHaveLength(1);
    expect(report.missingChunks[0]).toMatchObject({
      notePath: '10-Inbox/a.md',
      chunkIndex: 5,
    });
    expect(report.missingNotes).toEqual([]);
  });

  it('classifies a vanished note as missingNotes', async () => {
    // Engine has nothing for the cited path.
    adapter.files.set(
      '_drafts/x.md',
      draftWithCitations([{ note: '99-Gone/x.md', chunk: 0 }]),
    );
    const report = await verifyCitations({
      adapter,
      draftPath: '_drafts/x.md',
      selfEngine: selfEngine as unknown as SqliteEngine,
    });
    expect(report.hasDrift).toBe(true);
    expect(report.missingNotes).toHaveLength(1);
    expect(report.missingChunks).toEqual([]);
  });

  it('falls back to the corpus engine when chunk not in self', async () => {
    const corpusEngine = new FakeEngine();
    corpusEngine.add('20-Corpus/book.md', 3);
    adapter.files.set(
      '_drafts/x.md',
      draftWithCitations([{ note: '20-Corpus/book.md', chunk: 3 }]),
    );
    const report = await verifyCitations({
      adapter,
      draftPath: '_drafts/x.md',
      selfEngine: selfEngine as unknown as SqliteEngine,
      corpusEngine: corpusEngine as unknown as SqliteEngine,
    });
    expect(report.verified).toBe(1);
    expect(report.hasDrift).toBe(false);
  });

  it('handles a draft with no cited_chunks (returns total:0, no drift)', async () => {
    adapter.files.set('_drafts/x.md', draftWithCitations([]));
    const report = await verifyCitations({
      adapter,
      draftPath: '_drafts/x.md',
      selfEngine: selfEngine as unknown as SqliteEngine,
    });
    expect(report.total).toBe(0);
    expect(report.hasDrift).toBe(false);
  });

  it('throws on a non-draft path', async () => {
    adapter.files.set('30-Projects/x.md', '# real');
    await expect(
      verifyCitations({
        adapter,
        draftPath: '30-Projects/x.md',
        selfEngine: selfEngine as unknown as SqliteEngine,
      }),
    ).rejects.toThrow(/not a draft path/);
  });

  it('skips malformed cited_chunks entries (missing chunk index, wrong types)', async () => {
    adapter.files.set(
      '_drafts/x.md',
      [
        '---',
        'cited_chunks:',
        "  - { note: 'a.md', chunk: 0, score: 0.9 }",       // valid
        "  - { note: 'b.md' }",                              // missing chunk
        "  - { note: 'c.md', chunk: 'not-a-number' }",       // wrong type
        '  - "just a string row"',                           // not an object
        "  - { note: '', chunk: 0 }",                        // empty note path
        '---',
      ].join('\n'),
    );
    selfEngine.add('a.md', 0);
    const report = await verifyCitations({
      adapter,
      draftPath: '_drafts/x.md',
      selfEngine: selfEngine as unknown as SqliteEngine,
    });
    expect(report.total).toBe(1); // only the valid one
    expect(report.verified).toBe(1);
  });
});

describe('formatDriftSummary', () => {
  function r(over: Partial<CitationDriftReport>): CitationDriftReport {
    return {
      total: 0,
      verified: 0,
      missingChunks: [],
      missingNotes: [],
      hasDrift: false,
      ...over,
    };
  }

  it('says "no citations to verify" when total is 0', () => {
    expect(formatDriftSummary(r({}))).toBe('no citations to verify');
  });

  it('reports clean state when nothing has drifted', () => {
    expect(formatDriftSummary(r({ total: 5, verified: 5 }))).toBe(
      'all 5 citations verified',
    );
    expect(formatDriftSummary(r({ total: 1, verified: 1 }))).toBe(
      'all 1 citation verified',
    );
  });

  it('renders a compact summary with both classes of drift', () => {
    const summary = formatDriftSummary(
      r({
        total: 5,
        verified: 3,
        missingChunks: [
          { notePath: 'a.md', chunkIndex: 5, score: 0.5 },
        ],
        missingNotes: [{ notePath: 'b.md', chunkIndex: 0, score: 0.5 }],
        hasDrift: true,
      }),
    );
    expect(summary).toBe(
      'citation drift: 3/5 verified · 1 missing chunk · 1 missing note',
    );
  });

  it('handles plurals correctly', () => {
    const summary = formatDriftSummary(
      r({
        total: 6,
        verified: 2,
        missingChunks: [
          { notePath: 'a.md', chunkIndex: 5, score: 0.5 },
          { notePath: 'a.md', chunkIndex: 6, score: 0.5 },
        ],
        missingNotes: [
          { notePath: 'b.md', chunkIndex: 0, score: 0.5 },
          { notePath: 'c.md', chunkIndex: 0, score: 0.5 },
        ],
        hasDrift: true,
      }),
    );
    expect(summary).toBe(
      'citation drift: 2/6 verified · 2 missing chunks · 2 missing notes',
    );
  });
});
