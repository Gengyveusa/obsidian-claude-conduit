import type { MetadataCache, VaultAdapter } from '../agent/types';

import { extractWikilinks } from './rules/BrokenLinkRule';
import type { CorpusStat, CuratorCorpus } from './types';

/**
 * Phase 7 (v1.0.0 PR 3) — production `CuratorCorpus` adapter that
 * reads through `VaultAdapter` + `MetadataCache`. The orchestrator
 * builds one of these on each `Sagittarius: Run curator` invocation.
 *
 * `outboundLinks` and `backlinks` use Obsidian's resolved-link map
 * when available (cheap, in-memory), falling back to per-file content
 * parsing for vaults where the cache hasn't populated yet.
 */
export class VaultCorpus implements CuratorCorpus {
  constructor(
    private readonly adapter: VaultAdapter,
    private readonly metadata: MetadataCache,
  ) {}

  listAllMarkdown(): Promise<string[]> {
    return this.adapter.listAllMarkdown();
  }

  read(path: string): Promise<string> {
    return this.adapter.read(path);
  }

  async stat(path: string): Promise<CorpusStat | null> {
    const stat = await this.adapter.stat(path);
    if (stat === null) {
      return null;
    }
    // VaultAdapter exposes mtime in epoch SECONDS (per the embedding
    // contract §3); CuratorCorpus normalizes to epoch MILLISECONDS so
    // rules can do plain `Date.now() - mtime` arithmetic. Real ctime
    // isn't surfaced by Obsidian's adapter; mtime is the best available
    // approximation.
    const mtimeMs = stat.mtime * 1000;
    return {
      mtime: mtimeMs,
      ctime: mtimeMs,
      size: stat.size,
    };
  }

  async outboundLinks(path: string): Promise<string[]> {
    // Try the metadata cache's parsed links first — accurate and cheap.
    const meta = this.metadata.getFileMetadata(path);
    if (meta !== null && meta.links.length > 0) {
      return meta.links.map((l) => l.link);
    }
    // Fallback: parse the content directly. Used when the cache hasn't
    // populated for this file yet (rare; happens just after creation).
    try {
      const content = await this.adapter.read(path);
      return extractWikilinks(content).map((link) => link.target);
    } catch {
      return [];
    }
  }

  backlinks(path: string): Promise<string[]> {
    // resolvedLinks is keyed by source-path; values are { destPath: count }.
    // Invert: any source whose value-map contains `path` is a backlink source.
    const sources: string[] = [];
    const map = this.metadata.resolvedLinks;
    for (const sourcePath of Object.keys(map)) {
      const targets = map[sourcePath];
      if (targets[path] !== undefined && targets[path] > 0) {
        sources.push(sourcePath);
      }
    }
    return Promise.resolve(sources);
  }
}
