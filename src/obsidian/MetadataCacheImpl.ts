import type { App, TFile } from 'obsidian';

import type { FileMetadata, MetadataCache } from '../agent/types';

/**
 * Production MetadataCache wrapping Obsidian's `app.metadataCache`. Maps
 * Obsidian's per-file CachedMetadata into the simpler FileMetadata shape
 * used by `get_backlinks` and `get_graph_neighborhood`.
 *
 * @example
 *   const cache: MetadataCache = new MetadataCacheImpl(this.app);
 */
export class MetadataCacheImpl implements MetadataCache {
  constructor(private readonly app: App) {}

  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.app.metadataCache.resolvedLinks;
  }

  getFileMetadata(path: string): FileMetadata | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !this.isTFile(file)) {
      return null;
    }
    const meta = this.app.metadataCache.getFileCache(file);
    if (!meta) {
      return null;
    }
    return {
      links: (meta.links ?? []).map((linkRef) => ({
        link: linkRef.link,
        line: linkRef.position?.start?.line ?? 0,
      })),
      frontmatter: meta.frontmatter ?? null,
    };
  }

  resolveLink(linkText: string, sourcePath: string): string | null {
    const dest = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
    return dest ? dest.path : null;
  }

  private isTFile(file: { path: string }): file is TFile {
    // Duck-type: TFile has `.stat` and `.basename`.
    return 'stat' in file && 'basename' in file;
  }
}
