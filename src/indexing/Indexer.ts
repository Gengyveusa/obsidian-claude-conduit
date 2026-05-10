import type { EmbedClient } from '../retrieval/EmbedClient';
import type { SqliteEngine } from '../retrieval/SqliteEngine';
import type { BuildResult } from '../retrieval/types';
import type { VaultAdapter } from '../agent/types';
import { splitFrontmatter } from '../util/frontmatter';

import { chunk, DEFAULT_CHUNKER_OPTIONS, type ChunkerOptions } from './Chunker';

/**
 * mtime tolerance (seconds) for "unchanged" detection — matches contract §4.
 *
 * Note (v0.2.3): file enumeration moved from a recursive `adapter.list()`
 * walker to `adapter.listAllMarkdown()`. Empirically `app.vault.adapter.list('')`
 * threw silently in production Obsidian, so the walker terminated with 0
 * files. The new path uses Obsidian's `app.vault.getMarkdownFiles()` which
 * is the canonical enumeration API.
 */
const MTIME_TOLERANCE = 1.0;

export interface IndexProgress {
  processed: number;
  total: number;
  currentPath: string;
  /** Indexer phase: 'walking' (collecting files) or 'embedding' (per-file work). */
  phase: 'walking' | 'embedding';
}

export interface IndexerOptions {
  adapter: VaultAdapter;
  embedClient: EmbedClient;
  engine: SqliteEngine;
  /**
   * Folder prefixes to skip during indexing. v0.1 always excludes
   * `20-Corpus/` (corpus-ingest's namespace per contract §3) plus
   * the conversation log path so the agent doesn't re-index its own
   * outputs.
   */
  excludePathPrefixes?: string[];
  /** Chunking parameters. Defaults to contract-§2 1500/200. */
  chunkerOptions?: ChunkerOptions;
  /** Progress callback fired before each file is processed. */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Walk the vault, chunk each note, encode the chunks via EmbedClient,
 * and persist into the SqliteEngine. Idempotent on mtime — re-running
 * with `rebuild: false` skips files whose `last_modified` already matches
 * the engine's recorded value within `MTIME_TOLERANCE` seconds.
 *
 * Caller is responsible for persisting the engine to disk after `build`
 * completes (typically via IndexPersistence.save(engine.export())).
 *
 * @example
 *   const indexer = new Indexer({ adapter, embedClient, engine });
 *   const result = await indexer.build({ rebuild: false });
 *   await persistence.save(engine.export());
 */
export class Indexer {
  constructor(private readonly opts: IndexerOptions) {}

  /**
   * Run an index build. Default behavior is incremental (mtime-skip);
   * pass `{ rebuild: true }` to re-encode every file regardless.
   */
  async build({ rebuild = false }: { rebuild?: boolean } = {}): Promise<BuildResult> {
    const startedAt = Date.now();
    const errors: Array<{ path: string; error: string }> = [];
    let chunksAdded = 0;
    let chunksSkipped = 0;
    let notesProcessed = 0;

    const allPaths = await collectFiles(
      this.opts.adapter,
      this.opts.excludePathPrefixes ?? [],
      this.opts.onProgress,
    );

    for (let i = 0; i < allPaths.length; i++) {
      const path = allPaths[i];
      this.opts.onProgress?.({
        processed: i,
        total: allPaths.length,
        currentPath: path,
        phase: 'embedding',
      });

      try {
        const stat = await this.opts.adapter.stat(path);
        if (!stat) {
          continue;
        }

        if (!rebuild) {
          const existingMtime = this.opts.engine.getNoteMtime(path);
          if (existingMtime !== null && Math.abs(existingMtime - stat.mtime) < MTIME_TOLERANCE) {
            chunksSkipped += this.opts.engine.countChunksForPath(path);
            continue;
          }
        }

        const raw = await this.opts.adapter.read(path);
        const { body } = splitFrontmatter(raw);
        const chunks = chunk(body, this.opts.chunkerOptions ?? DEFAULT_CHUNKER_OPTIONS);

        // Always wipe existing chunks first so a partial result on failure
        // doesn't leave stale rows alongside fresh ones (contract §4).
        this.opts.engine.deleteChunksForPath(path);

        if (chunks.length === 0) {
          this.opts.engine.upsertNote({
            path,
            title: null,
            source: null,
            doctrineAlignment: null,
            lastModified: stat.mtime,
            chunkCount: 0,
          });
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
          });
        }

        this.opts.engine.upsertNote({
          path,
          title: null,
          source: null,
          doctrineAlignment: null,
          lastModified: stat.mtime,
          chunkCount: chunks.length,
        });

        chunksAdded += chunks.length;
        notesProcessed++;
      } catch (err) {
        errors.push({ path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      notesProcessed,
      chunksAdded,
      chunksSkipped,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Return every `.md` path the vault knows about, minus excluded prefixes.
 *
 * Backed by `adapter.listAllMarkdown()` — production wraps Obsidian's
 * `app.vault.getMarkdownFiles()`. The previous BFS walker through
 * `adapter.list()` silently terminated when `list('')` threw, leaving
 * the indexer with 0 files (v0.2.3 fix).
 */
async function collectFiles(
  adapter: VaultAdapter,
  excludePrefixes: string[],
  onProgress: ((progress: IndexProgress) => void) | undefined,
): Promise<string[]> {
  const all = await adapter.listAllMarkdown();
  const out = all.filter((p) => p.endsWith('.md') && !isExcluded(p, excludePrefixes));
  out.sort();
  onProgress?.({
    processed: out.length,
    total: out.length,
    currentPath: '',
    phase: 'walking',
  });
  return out;
}

function isExcluded(path: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
