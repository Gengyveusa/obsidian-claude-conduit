import type { IndexPersistence } from './IndexPersistence';
import { Indexer, type IndexerOptions, type IndexProgress } from './Indexer';
import type { BuildResult } from '../retrieval/types';
import type { SqliteEngine } from '../retrieval/SqliteEngine';

export interface IndexCoordinatorOptions extends Omit<IndexerOptions, 'engine'> {
  engine: SqliteEngine;
  persistence: IndexPersistence;
  /** Fires whenever an in-flight build progresses. */
  onProgress?: (progress: IndexProgress) => void;
  /** Fires once a build settles (success). */
  onComplete?: (result: BuildResult) => void;
  /** Fires once a build settles (failure). */
  onError?: (err: Error) => void;
}

/**
 * Owns the persistent SqliteEngine + Indexer lifecycle. Responsibilities:
 *
 *   1. Run a build (`ensureBuilt()`), de-duplicating concurrent requests
 *      so two callers can't race the engine.
 *   2. Persist the engine buffer to disk via IndexPersistence after a
 *      successful build.
 *   3. Surface progress + completion callbacks to the UI.
 *
 * Doesn't own the engine itself (caller passes one in) — keeps tests
 * deterministic and lets main.ts manage the load-from-disk-or-create
 * decision.
 *
 * @example
 *   const coord = new IndexCoordinator({ adapter, embedClient, engine, persistence, ... });
 *   await coord.ensureBuilt();           // initial build (background-safe)
 *   await coord.ensureBuilt({ rebuild: true }); // forced full rebuild
 */
export class IndexCoordinator {
  private readonly indexer: Indexer;
  private inFlight: Promise<BuildResult> | null = null;

  constructor(private readonly opts: IndexCoordinatorOptions) {
    this.indexer = new Indexer({
      adapter: opts.adapter,
      embedClient: opts.embedClient,
      engine: opts.engine,
      ...(opts.excludePathPrefixes ? { excludePathPrefixes: opts.excludePathPrefixes } : {}),
      ...(opts.chunkerOptions ? { chunkerOptions: opts.chunkerOptions } : {}),
      onProgress: (p) => this.opts.onProgress?.(p),
    });
  }

  /** True if a build is currently in flight. */
  isBuilding(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Run a build (or return the in-flight promise if one is already
   * running). On `rebuild: true`, waits for any in-flight incremental
   * build to finish, then runs a fresh full rebuild.
   * @example await coord.ensureBuilt({ rebuild: false });
   */
  async ensureBuilt({ rebuild = false }: { rebuild?: boolean } = {}): Promise<BuildResult> {
    if (this.inFlight && !rebuild) {
      return this.inFlight;
    }
    if (this.inFlight && rebuild) {
      // Let the in-flight build settle (success or failure) before queuing
      // a rebuild so we don't write the engine concurrently.
      try {
        await this.inFlight;
      } catch {
        // Swallow; this rebuild is independent.
      }
    }
    this.inFlight = this.runBuild({ rebuild });
    return this.inFlight;
  }

  private async runBuild(opts: { rebuild: boolean }): Promise<BuildResult> {
    try {
      const result = await this.indexer.build(opts);
      const buffer = this.opts.engine.export();
      await this.opts.persistence.save(buffer);
      this.opts.onComplete?.(result);
      return result;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this.opts.onError?.(wrapped);
      throw wrapped;
    } finally {
      this.inFlight = null;
    }
  }
}
