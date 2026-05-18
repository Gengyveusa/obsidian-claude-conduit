import type { EmbedClient } from '../retrieval/EmbedClient';
import type { SqliteEngine } from '../retrieval/SqliteEngine';
import type { VaultAdapter } from '../agent/types';
import { chunk, DEFAULT_CHUNKER_OPTIONS, type ChunkerOptions } from '../indexing/Chunker';
import { splitFrontmatter } from '../util/frontmatter';

/**
 * Phase 16 (v1.10.0) — snapshot the current vault state into the index
 * under a given commit SHA per ADR-037 D3.
 *
 * The "current vault state" caveat is important: the operator's
 * worktree IS the snapshot source. If they want to snapshot a past
 * commit, they `git checkout <sha>` first, then invoke
 * `Sagittarius: Snapshot vault for time-travel`. This stays consistent
 * with ADR-037 D3's "manual command + automatic on git tags" model —
 * tags will fire on tag-push regardless of current HEAD (v2.0.1 follow-
 * up), and the manual command captures whatever the operator's
 * vault looks like now.
 *
 * Failure modes:
 *   - `engine.countChunksAtCommit(sha) > 0` → idempotent skip with a
 *     friendly `BuildResult` indicating no work was done.
 *   - Per-file errors are collected per existing Indexer convention;
 *     they don't abort the snapshot.
 */

export interface SnapshotIndexerOptions {
  adapter: VaultAdapter;
  embedClient: EmbedClient;
  engine: SqliteEngine;
  /** Folder prefixes to skip — mirrors the main Indexer's exclude list. */
  excludePathPrefixes?: string[];
  chunkerOptions?: ChunkerOptions;
  /** Optional progress callback (notes processed / total). */
  onProgress?: (progress: { processed: number; total: number; currentPath: string }) => void;
}

export interface SnapshotResult {
  /** True if a snapshot for this SHA already existed and was skipped. */
  alreadyExisted: boolean;
  notesProcessed: number;
  chunksAdded: number;
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
}

export class SnapshotIndexer {
  constructor(private readonly opts: SnapshotIndexerOptions) {}

  /**
   * Index every note in the current vault under `commit_sha = <sha>`.
   * Idempotent per (sha): re-running for an existing snapshot returns
   * `alreadyExisted: true` without doing work, per ADR-037 D3.
   *
   * @example
   *   const indexer = new SnapshotIndexer({ adapter, embedClient, engine });
   *   const result = await indexer.snapshot('abc123');
   */
  async snapshot(commitSha: string): Promise<SnapshotResult> {
    const startedAt = Date.now();
    const errors: Array<{ path: string; error: string }> = [];
    let chunksAdded = 0;
    let notesProcessed = 0;

    if (commitSha.length === 0) {
      throw new Error(
        'SnapshotIndexer.snapshot: commitSha must be non-empty. ' +
          'Resolve git HEAD via readHeadSha() before calling.',
      );
    }

    if (this.opts.engine.countChunksAtCommit(commitSha) > 0) {
      return {
        alreadyExisted: true,
        notesProcessed: 0,
        chunksAdded: 0,
        errors: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const allPaths = await this.collectFiles();

    for (let i = 0; i < allPaths.length; i++) {
      const path = allPaths[i];
      this.opts.onProgress?.({ processed: i, total: allPaths.length, currentPath: path });

      try {
        const raw = await this.opts.adapter.read(path);
        const { body } = splitFrontmatter(raw);
        const chunks = chunk(body, this.opts.chunkerOptions ?? DEFAULT_CHUNKER_OPTIONS);

        if (chunks.length === 0) {
          notesProcessed++;
          continue;
        }

        const embeddings = await this.opts.embedClient.encodeBatch(chunks);
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
          this.opts.engine.upsertChunk({
            notePath: path,
            chunkIndex: chunkIdx,
            text: chunks[chunkIdx],
            embedding: embeddings[chunkIdx],
            commitSha,
          });
        }
        chunksAdded += chunks.length;
        notesProcessed++;
      } catch (err) {
        errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      alreadyExisted: false,
      notesProcessed,
      chunksAdded,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  private async collectFiles(): Promise<string[]> {
    const all = await this.opts.adapter.listAllMarkdown();
    const excludes = this.opts.excludePathPrefixes ?? [];
    const out = all.filter((p) => p.endsWith('.md') && !isExcluded(p, excludes));
    out.sort();
    return out;
  }
}

function isExcluded(path: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
