import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Indexer, type IndexProgress } from '../../src/indexing/Indexer';
import {
  EmbedClient,
  type EmbedPipeline,
  type EmbedPipelineFactory,
} from '../../src/retrieval/EmbedClient';
import { SqliteEngine, VECTOR_DIM } from '../../src/retrieval/SqliteEngine';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';

interface FakeFile {
  content: string;
  stat: VaultStat;
}

class FakeAdapter implements VaultAdapter {
  /** Paths whose stat() should reject — used to simulate per-file failures. */
  failStatPaths = new Set<string>();

  constructor(
    private readonly files: Map<string, FakeFile>,
    private readonly tree: Map<string, { files: string[]; folders: string[] }>,
  ) {}

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.tree.has(path));
  }
  read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) {
      return Promise.reject(new Error(`not found: ${path}`));
    }
    return Promise.resolve(f.content);
  }
  readBinary(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  writeBinary(): Promise<void> {
    return Promise.resolve();
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(path: string): Promise<VaultStat | null> {
    if (this.failStatPaths.has(path)) {
      return Promise.reject(new Error(`synthetic stat failure: ${path}`));
    }
    return Promise.resolve(this.files.get(path)?.stat ?? null);
  }
  list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve(this.tree.get(folder) ?? { files: [], folders: [] });
  }
}

function buildAdapter(spec: {
  files: Record<string, { content: string; mtime?: number; size?: number }>;
  tree: Record<string, { files?: string[]; folders?: string[] }>;
}): FakeAdapter {
  const files = new Map<string, FakeFile>();
  for (const [path, f] of Object.entries(spec.files)) {
    files.set(path, {
      content: f.content,
      stat: { mtime: f.mtime ?? 1000, size: f.size ?? f.content.length },
    });
  }
  const tree = new Map<string, { files: string[]; folders: string[] }>();
  for (const [folder, entry] of Object.entries(spec.tree)) {
    tree.set(folder, {
      files: entry.files ?? [],
      folders: entry.folders ?? [],
    });
  }
  return new FakeAdapter(files, tree);
}

/**
 * Stub pipeline that returns a deterministic fake vector for any input.
 * Each input string is hashed to a fixed axis so tests can reason about
 * which chunk produced which vector if needed.
 */
function stubPipelineFactory(): EmbedPipelineFactory {
  const pipeline: EmbedPipeline = (text) => {
    const inputs = Array.isArray(text) ? text : [text];
    const out = new Float32Array(inputs.length * VECTOR_DIM);
    for (let i = 0; i < inputs.length; i++) {
      // Pick an axis from a tiny hash so different inputs differ.
      let h = 0;
      for (let c = 0; c < inputs[i].length; c++) {
        h = (h + inputs[i].charCodeAt(c)) % VECTOR_DIM;
      }
      out[i * VECTOR_DIM + h] = 1.0;
    }
    return Promise.resolve({ data: out });
  };
  return () => Promise.resolve(pipeline);
}

let engine: SqliteEngine;
let embedClient: EmbedClient;

beforeEach(async () => {
  engine = await SqliteEngine.open({ writerVersion: 'test-0.0.1' });
  embedClient = new EmbedClient(stubPipelineFactory());
});

describe('Indexer', () => {
  it('walks the vault, chunks each note, encodes, and persists', async () => {
    const adapter = buildAdapter({
      files: {
        'a.md': { content: 'Para one.\n\nPara two.', mtime: 100 },
        'docs/b.md': { content: 'Body of B.', mtime: 200 },
      },
      tree: {
        '': { files: ['a.md'], folders: ['docs'] },
        docs: { files: ['docs/b.md'] },
      },
    });

    const indexer = new Indexer({ adapter, embedClient, engine });
    const result = await indexer.build();

    expect(result.notesProcessed).toBe(2);
    expect(result.chunksAdded).toBeGreaterThanOrEqual(2);
    expect(result.errors).toEqual([]);
    expect(engine.count('chunks')).toBe(result.chunksAdded);
    expect(engine.count('notes')).toBe(2);
    expect(engine.getNoteMtime('a.md')).toBe(100);
    expect(engine.getNoteMtime('docs/b.md')).toBe(200);
  });

  it('strips frontmatter before chunking', async () => {
    const adapter = buildAdapter({
      files: {
        'a.md': {
          content: '---\ntitle: T\n---\nBody only goes into chunks.',
          mtime: 1,
        },
      },
      tree: { '': { files: ['a.md'] } },
    });

    const indexer = new Indexer({ adapter, embedClient, engine });
    await indexer.build();

    const chunk = engine.getChunk('a.md', 0);
    expect(chunk).not.toBeNull();
    expect(chunk?.text).toBe('Body only goes into chunks.');
    expect(chunk?.text).not.toContain('title:');
  });

  it('skips files whose mtime is unchanged on incremental rebuild', async () => {
    const adapter = buildAdapter({
      files: { 'a.md': { content: 'Body.', mtime: 100 } },
      tree: { '': { files: ['a.md'] } },
    });

    const indexer = new Indexer({ adapter, embedClient, engine });
    const first = await indexer.build();
    expect(first.chunksAdded).toBeGreaterThan(0);

    // Spy on encode to confirm second pass doesn't re-encode.
    const encodeSpy = vi.spyOn(embedClient, 'encodeBatch');
    const second = await indexer.build();

    expect(second.chunksAdded).toBe(0);
    expect(second.chunksSkipped).toBe(first.chunksAdded);
    expect(encodeSpy).not.toHaveBeenCalled();
  });

  it('re-encodes when mtime advances past the tolerance window', async () => {
    const files = { 'a.md': { content: 'Body one.', mtime: 100 } };
    const tree = { '': { files: ['a.md'] } };
    let adapter = buildAdapter({ files, tree });
    const indexer1 = new Indexer({ adapter, embedClient, engine });
    await indexer1.build();

    // Bump mtime + change body to ensure the second build sees it.
    files['a.md'] = { content: 'Body two.', mtime: 200 };
    adapter = buildAdapter({ files, tree });

    const indexer2 = new Indexer({ adapter, embedClient, engine });
    const second = await indexer2.build();
    expect(second.notesProcessed).toBe(1);
    expect(second.chunksAdded).toBeGreaterThan(0);

    const chunk = engine.getChunk('a.md', 0);
    expect(chunk?.text).toBe('Body two.');
  });

  it('rebuild=true ignores mtime and re-encodes everything', async () => {
    const adapter = buildAdapter({
      files: { 'a.md': { content: 'Body.', mtime: 100 } },
      tree: { '': { files: ['a.md'] } },
    });

    const indexer = new Indexer({ adapter, embedClient, engine });
    await indexer.build();

    const encodeSpy = vi.spyOn(embedClient, 'encodeBatch');
    const second = await indexer.build({ rebuild: true });
    expect(second.notesProcessed).toBe(1);
    expect(encodeSpy).toHaveBeenCalled();
  });

  it('respects excludePathPrefixes (e.g. 20-Corpus/)', async () => {
    const adapter = buildAdapter({
      files: {
        'a.md': { content: 'kept', mtime: 1 },
        '20-Corpus/excluded.md': { content: 'should not index', mtime: 1 },
      },
      tree: {
        '': { files: ['a.md'], folders: ['20-Corpus'] },
        '20-Corpus': { files: ['20-Corpus/excluded.md'] },
      },
    });

    const indexer = new Indexer({
      adapter,
      embedClient,
      engine,
      excludePathPrefixes: ['20-Corpus/'],
    });
    const result = await indexer.build();
    expect(result.notesProcessed).toBe(1);
    expect(engine.getChunk('a.md', 0)).not.toBeNull();
    expect(engine.getChunk('20-Corpus/excluded.md', 0)).toBeNull();
  });

  it('records empty-body files in notes table with chunk_count = 0', async () => {
    const adapter = buildAdapter({
      files: {
        'empty.md': { content: '---\ntitle: T\n---\n', mtime: 1 },
      },
      tree: { '': { files: ['empty.md'] } },
    });

    const indexer = new Indexer({ adapter, embedClient, engine });
    await indexer.build();
    expect(engine.getNoteMtime('empty.md')).toBe(1);
    expect(engine.countChunksForPath('empty.md')).toBe(0);
  });

  it('captures errors per-file without aborting the whole build', async () => {
    const adapter = buildAdapter({
      files: { 'good.md': { content: 'kept', mtime: 1 } },
      tree: { '': { files: ['good.md', 'bad.md'] } },
    });
    adapter.failStatPaths.add('bad.md');

    const indexer = new Indexer({ adapter, embedClient, engine });
    const result = await indexer.build();
    expect(result.notesProcessed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe('bad.md');
    expect(result.errors[0]?.error).toContain('stat failure');
  });

  it('fires onProgress for both walking and embedding phases', async () => {
    const adapter = buildAdapter({
      files: {
        'a.md': { content: 'A', mtime: 1 },
        'b.md': { content: 'B', mtime: 1 },
      },
      tree: { '': { files: ['a.md', 'b.md'] } },
    });

    const events: IndexProgress[] = [];
    const indexer = new Indexer({
      adapter,
      embedClient,
      engine,
      onProgress: (p) => events.push(p),
    });
    await indexer.build();

    expect(events.some((e) => e.phase === 'walking')).toBe(true);
    expect(events.some((e) => e.phase === 'embedding')).toBe(true);
    const embeddingEvents = events.filter((e) => e.phase === 'embedding');
    expect(embeddingEvents.length).toBe(2);
  });

  it('uphold contract §4: failed file ingest leaves no partial chunks', async () => {
    // First, index successfully.
    const goodAdapter = buildAdapter({
      files: { 'a.md': { content: 'Para 1.\n\nPara 2.\n\nPara 3.', mtime: 1 } },
      tree: { '': { files: ['a.md'] } },
    });
    const indexer1 = new Indexer({ adapter: goodAdapter, embedClient, engine });
    await indexer1.build();
    const initialCount = engine.countChunksForPath('a.md');
    expect(initialCount).toBeGreaterThan(0);

    // Now induce an encode failure mid-way and rebuild.
    const flakyEmbedClient = new EmbedClient(() =>
      Promise.resolve(((_text: string | string[]) =>
        Promise.reject(new Error('encode boom'))) as EmbedPipeline),
    );
    const indexer2 = new Indexer({
      adapter: goodAdapter,
      embedClient: flakyEmbedClient,
      engine,
    });
    const result = await indexer2.build({ rebuild: true });

    expect(result.errors).toHaveLength(1);
    // After failure, deleteChunksForPath ran but the upserts didn't —
    // no partial rows survive.
    expect(engine.countChunksForPath('a.md')).toBe(0);
  });
});
