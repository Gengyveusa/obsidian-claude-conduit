import { beforeEach, describe, expect, it } from 'vitest';

import { SnapshotIndexer } from '../../src/timetravel/SnapshotIndexer';
import { SqliteEngine, VECTOR_DIM } from '../../src/retrieval/SqliteEngine';
import type { EmbedClient } from '../../src/retrieval/EmbedClient';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const c = this.files.get(path);
    if (c === undefined) {
      throw new Error(`not found: ${path}`);
    }
    return Promise.resolve(c);
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
  delete(): Promise<void> {
    return Promise.resolve();
  }
  renameFile(): Promise<void> {
    return Promise.resolve();
  }
  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()].filter((p) => p.endsWith('.md')));
  }
}

class StubEmbedClient implements Pick<EmbedClient, 'encode' | 'encodeBatch'> {
  calls = 0;
  encode(_text: string): Promise<Float32Array> {
    this.calls++;
    return Promise.resolve(new Float32Array(VECTOR_DIM).fill(0.1));
  }
  encodeBatch(texts: string[]): Promise<Float32Array[]> {
    this.calls += texts.length;
    return Promise.resolve(
      texts.map(() => new Float32Array(VECTOR_DIM).fill(0.1)),
    );
  }
}

const SHA_A = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const SHA_B = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';

let adapter: MemAdapter;
let embedClient: StubEmbedClient;
let engine: SqliteEngine;

beforeEach(async () => {
  adapter = new MemAdapter();
  embedClient = new StubEmbedClient();
  engine = await SqliteEngine.open({ writerVersion: 'test' });
});

describe('SnapshotIndexer (Phase 16 / ADR-037 D3)', () => {
  it('snapshots every note under the given commit SHA', async () => {
    adapter.files.set('a.md', 'hello world');
    adapter.files.set('b.md', 'another note');
    const indexer = new SnapshotIndexer({
      adapter,
      embedClient: embedClient as unknown as EmbedClient,
      engine,
    });

    const result = await indexer.snapshot(SHA_A);
    expect(result.alreadyExisted).toBe(false);
    expect(result.notesProcessed).toBe(2);
    expect(result.chunksAdded).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);

    const snapshotted = engine.allChunks({ commitSha: SHA_A });
    expect(snapshotted.length).toBeGreaterThan(0);
    expect(snapshotted.every((c) => c.commitSha === SHA_A)).toBe(true);
    // Current-state remains empty.
    expect(engine.allChunks()).toHaveLength(0);
  });

  it('is idempotent on re-run for the same SHA', async () => {
    adapter.files.set('a.md', 'hello world');
    const indexer = new SnapshotIndexer({
      adapter,
      embedClient: embedClient as unknown as EmbedClient,
      engine,
    });

    const first = await indexer.snapshot(SHA_A);
    expect(first.alreadyExisted).toBe(false);
    expect(first.notesProcessed).toBe(1);

    const before = embedClient.calls;
    const second = await indexer.snapshot(SHA_A);
    expect(second.alreadyExisted).toBe(true);
    expect(second.notesProcessed).toBe(0);
    expect(second.chunksAdded).toBe(0);
    // No additional embedding calls — short-circuit honored.
    expect(embedClient.calls).toBe(before);
  });

  it('rejects an empty SHA with an actionable error', async () => {
    const indexer = new SnapshotIndexer({
      adapter,
      embedClient: embedClient as unknown as EmbedClient,
      engine,
    });
    await expect(indexer.snapshot('')).rejects.toThrow(/commitSha must be non-empty/);
  });

  it('honors excludePathPrefixes', async () => {
    adapter.files.set('a.md', 'kept');
    adapter.files.set('20-Corpus/skip.md', 'excluded');
    const indexer = new SnapshotIndexer({
      adapter,
      embedClient: embedClient as unknown as EmbedClient,
      engine,
      excludePathPrefixes: ['20-Corpus/'],
    });
    const result = await indexer.snapshot(SHA_A);
    expect(result.notesProcessed).toBe(1);
    const paths = new Set(engine.allChunks({ commitSha: SHA_A }).map((c) => c.notePath));
    expect(paths).toEqual(new Set(['a.md']));
  });

  it('two different SHAs produce two distinct snapshots', async () => {
    adapter.files.set('a.md', 'first state');
    const indexer = new SnapshotIndexer({
      adapter,
      embedClient: embedClient as unknown as EmbedClient,
      engine,
    });

    await indexer.snapshot(SHA_A);

    // Operator pretends to checkout a different commit and re-runs.
    adapter.files.set('a.md', 'second state');
    await indexer.snapshot(SHA_B);

    const aSnap = engine.allChunks({ commitSha: SHA_A });
    const bSnap = engine.allChunks({ commitSha: SHA_B });
    expect(aSnap.length).toBeGreaterThan(0);
    expect(bSnap.length).toBeGreaterThan(0);
    expect(aSnap[0].text).toContain('first state');
    expect(bSnap[0].text).toContain('second state');
  });

  it('skips empty notes without error', async () => {
    adapter.files.set('a.md', '');
    const indexer = new SnapshotIndexer({
      adapter,
      embedClient: embedClient as unknown as EmbedClient,
      engine,
    });
    const result = await indexer.snapshot(SHA_A);
    expect(result.notesProcessed).toBe(1);
    expect(result.chunksAdded).toBe(0);
    expect(engine.allChunks({ commitSha: SHA_A })).toHaveLength(0);
  });
});
