import type { VaultAdapter } from '../agent/types';

import { analyzeMocShape, type MocShapeMetrics } from './MocDetection';

/**
 * Phase 5 (v0.6.x) — discovers MOC notes under configured folders.
 *
 * Lazy + cacheable: `discover()` is the only entrypoint. It enumerates
 * every `.md` file under the configured folders, runs `analyzeMocShape`
 * on each, and returns the candidates that pass the heuristic.
 *
 * Production callers (the moc-add classifier in v0.6.x PR 2) cache the
 * result and re-discover when the user edits `organizationMocFolders`
 * or when notes in those folders change. Cheap to call: O(N * filesize)
 * over `.md` files in the configured folders only.
 */
export interface MocCandidate {
  /** Vault-relative path of the MOC note. */
  path: string;
  /** Basename without extension — used as a fallback title when no heading. */
  basename: string;
  /** First heading found in the body, or null if none. */
  firstHeading: string | null;
  /** Number of wikilink-bullet lines. Useful for ranking candidates. */
  wikilinkBulletCount: number;
  /** Full shape metrics — exposed for prompt construction. */
  metrics: MocShapeMetrics;
}

export interface MocDiscoveryDeps {
  adapter: VaultAdapter;
  /**
   * Vault-relative folders to scan. Trailing slashes are normalized.
   * Empty array means MOC detection is disabled — `discover()` returns
   * `[]` without doing any I/O.
   */
  mocFolders: string[];
}

export class MocDiscovery {
  private readonly adapter: VaultAdapter;
  private readonly mocFolders: string[];

  constructor(deps: MocDiscoveryDeps) {
    this.adapter = deps.adapter;
    this.mocFolders = deps.mocFolders.map(stripTrailingSlash);
  }

  /**
   * Scan configured folders and return MOC candidates.
   *
   * Behavior:
   *   - Returns `[]` immediately when no folders are configured.
   *   - Uses `adapter.listAllMarkdown()` + prefix-filter (cheap; canonical
   *     Obsidian API per ADR-015).
   *   - Reads each candidate's content to run the shape heuristic.
   *   - Files that fail to read are silently skipped — discovery is best-
   *     effort, not a critical-path operation.
   */
  async discover(): Promise<MocCandidate[]> {
    if (this.mocFolders.length === 0) {
      return [];
    }

    const allMarkdown = await this.adapter.listAllMarkdown();
    const candidatePaths = allMarkdown.filter((path) =>
      this.mocFolders.some((folder) => path.startsWith(`${folder}/`)),
    );

    const results: MocCandidate[] = [];
    for (const path of candidatePaths) {
      let content: string;
      try {
        content = await this.adapter.read(path);
      } catch {
        continue; // skip unreadable files
      }
      const metrics = analyzeMocShape(content);
      if (!metrics.looksLikeMoc) {
        continue;
      }
      results.push({
        path,
        basename: basenameWithoutExt(path),
        firstHeading: metrics.firstHeading,
        wikilinkBulletCount: metrics.wikilinkBulletCount,
        metrics,
      });
    }

    // Sort by wikilink count descending — denser MOCs first, so the
    // classifier prompt (PR 2) leads with the most "settled" candidates.
    results.sort((a, b) => b.wikilinkBulletCount - a.wikilinkBulletCount);
    return results;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function basenameWithoutExt(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/, '');
}
