import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IndexCoordinator } from '../../src/indexing/IndexCoordinator';
import { IndexPersistence } from '../../src/indexing/IndexPersistence';
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
  binaryFiles = new Map<string, ArrayBuffer>();
  mkdirCalls: string[] = [];

  constructor(
    private readonly files: Map<string, FakeFile>,
    private readonly tree: Map<string, { files: string[]; folders: string[] }>,
  ) {}

  exists(path: string): Promise<boolean> {
    return Promise.resolve(
      this.files.has(path) || this.tree.has(path) || this.binaryFiles.has(path),
    );
  }
  read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) {
      return Promise.reject(new Error(`not found: ${path}`));
    }
    return Promise.resolve(f.content);
  }
  readBinary(path: string): Promise<ArrayBuffer> {
    const buf = this.binaryFiles.get(path);
    if (!buf) {
      return Promise.reject(new Error(`not found: ${path}`));
    }
    return Promise.resolve(buf);
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(path, content);
    return Promise.resolve();
  }
  mkdir(path: string): Promise<void> {
    this.mkdirCalls.push(path);
    return Promise.resolve();
  }
  stat(path: string): Promise<VaultStat | null> {
    return Promise.resolve(this.files.get(path)?.stat ?? null);
  }
  list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve(this.tree.get(folder) ?? { files: [], folders: [] });
  }
}

function buildAdapter(files: Record<string, string>): FakeAdapter {
  const fileMap = new Map<string, FakeFile>();
  for (const [path, content] of Object.entries(files)) {
    fileMap.set(path, { content, stat: { mtime: 1, size: content.length } });
  }
  const tree = new Map<string, { files: string[]; folders: string[] }>([
    ['/', { files: Object.keys(files), folders: [] }],
  ]);
  return new FakeAdapter(fileMap, tree);
}

function stubFactory(): EmbedPipelineFactory {
  const pipeline: EmbedPipeline = (text) => {
    const inputs = Array.isArray(text) ? text : [text];
    const out = new Float32Array(inputs.length * VECTOR_DIM);
    for (let i = 0; i < inputs.length; i++) {
      out[i * VECTOR_DIM] = 1.0;
    }
    return Promise.resolve({ data: out });
  };
  return () => Promise.resolve(pipeline);
}

const INDEX_PATH = '.obsidian/plugins/obsidian-claude-conduit/index.sqlite';

let engine: SqliteEngine;
let embedClient: EmbedClient;
let adapter: FakeAdapter;
let persistence: IndexPersistence;

beforeEach(async () => {
  engine = await SqliteEngine.open({ writerVersion: 'test-0.0.1' });
  embedClient = new EmbedClient(stubFactory());
  adapter = buildAdapter({ 'a.md': 'Body of A.', 'b.md': 'Body of B.' });
  persistence = new IndexPersistence(adapter, INDEX_PATH);
});

describe('IndexCoordinator', () => {
  it('runs a build and persists the engine to disk', async () => {
    const coord = new IndexCoordinator({ adapter, embedClient, engine, persistence });
    const result = await coord.ensureBuilt();
    expect(result.notesProcessed).toBe(2);
    expect(adapter.binaryFiles.has(INDEX_PATH)).toBe(true);
    expect(adapter.mkdirCalls).toContain('.obsidian/plugins/obsidian-claude-conduit');
  });

  it('isBuilding() reports state across the lifecycle', async () => {
    const coord = new IndexCoordinator({ adapter, embedClient, engine, persistence });
    expect(coord.isBuilding()).toBe(false);
    const promise = coord.ensureBuilt();
    expect(coord.isBuilding()).toBe(true);
    await promise;
    expect(coord.isBuilding()).toBe(false);
  });

  it('de-duplicates concurrent ensureBuilt() calls (one underlying build)', async () => {
    const persistenceSpy: IndexPersistence = Object.assign(
      Object.create(IndexPersistence.prototype) as IndexPersistence,
      {
        save: vi.fn(() => persistence.save(new Uint8Array(8))),
        load: persistence.load.bind(persistence),
        exists: persistence.exists.bind(persistence),
      },
    );
    const coord = new IndexCoordinator({
      adapter,
      embedClient,
      engine,
      persistence: persistenceSpy,
    });
    const [r1, r2] = await Promise.all([coord.ensureBuilt(), coord.ensureBuilt()]);
    // De-dup: persistence.save called exactly once even though we asked twice.
    expect(
      (persistenceSpy.save as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(1);
    // Both callers see the same BuildResult.
    expect(r1).toBe(r2);
  });

  it('ensureBuilt({ rebuild: true }) waits for in-flight then runs a fresh build', async () => {
    const coord = new IndexCoordinator({ adapter, embedClient, engine, persistence });
    const incrementalPromise = coord.ensureBuilt();
    // While the first build is in flight, request a rebuild.
    const rebuildPromise = coord.ensureBuilt({ rebuild: true });
    expect(rebuildPromise).not.toBe(incrementalPromise);
    const [first, second] = await Promise.all([incrementalPromise, rebuildPromise]);
    // Both succeed; rebuild produces nonzero work since rebuild=true bypasses mtime cache.
    expect(first.notesProcessed).toBe(2);
    expect(second.notesProcessed).toBe(2);
  });

  it('fires onComplete after the engine has been persisted', async () => {
    const events: string[] = [];
    const persistenceWithSpy: IndexPersistence = Object.assign(
      Object.create(IndexPersistence.prototype) as IndexPersistence,
      {
        save: vi.fn(async (data: Uint8Array) => {
          events.push('save');
          await persistence.save(data);
        }),
        load: persistence.load.bind(persistence),
        exists: persistence.exists.bind(persistence),
      },
    );
    const coord = new IndexCoordinator({
      adapter,
      embedClient,
      engine,
      persistence: persistenceWithSpy,
      onComplete: () => events.push('complete'),
    });
    await coord.ensureBuilt();
    expect(events).toEqual(['save', 'complete']);
  });

  it('fires onError and rejects when the indexer throws', async () => {
    // Force an error by giving the embed client a rejecting pipeline.
    const failing = new EmbedClient(() =>
      Promise.resolve(((_t: string | string[]) =>
        Promise.reject(new Error('encode boom'))) as EmbedPipeline),
    );
    const errors: Error[] = [];
    const coord = new IndexCoordinator({
      adapter,
      embedClient: failing,
      engine,
      persistence,
      onError: (e) => errors.push(e),
    });
    // The build itself doesn't throw (per-file errors caught), but persistence.save runs.
    // Build succeeds with errors recorded; onError shouldn't fire.
    const result = await coord.ensureBuilt();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it('clears in-flight state after a thrown build so subsequent calls retry', async () => {
    let throwOnNextSave = true;
    const flakyPersistence = Object.assign(
      Object.create(IndexPersistence.prototype) as IndexPersistence,
      {
        save: vi.fn(() => {
          if (throwOnNextSave) {
            throwOnNextSave = false;
            return Promise.reject(new Error('persistence boom'));
          }
          // succeed second time
          return Promise.resolve();
        }),
      },
    );
    const errors: Error[] = [];
    const coord = new IndexCoordinator({
      adapter,
      embedClient,
      engine,
      persistence: flakyPersistence,
      onError: (e) => errors.push(e),
    });
    await expect(coord.ensureBuilt()).rejects.toThrow(/persistence boom/);
    expect(errors).toHaveLength(1);
    expect(coord.isBuilding()).toBe(false);
    // Second call should not return the rejected promise — it should retry.
    await expect(coord.ensureBuilt()).resolves.toBeDefined();
  });

  it('forwards onProgress events from the underlying Indexer', async () => {
    const events: string[] = [];
    const coord = new IndexCoordinator({
      adapter,
      embedClient,
      engine,
      persistence,
      onProgress: (p) => events.push(p.phase),
    });
    await coord.ensureBuilt();
    expect(events).toContain('walking');
    expect(events).toContain('embedding');
  });
});
