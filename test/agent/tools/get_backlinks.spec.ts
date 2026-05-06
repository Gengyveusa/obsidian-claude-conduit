import { describe, expect, it } from 'vitest';

import { makeGetBacklinksTool } from '../../../src/agent/tools/get_backlinks';
import type { FileMetadata, MetadataCache } from '../../../src/agent/types';

function fakeCache(opts: {
  resolvedLinks: Record<string, Record<string, number>>;
  metadata?: Record<string, FileMetadata>;
}): MetadataCache {
  return {
    resolvedLinks: opts.resolvedLinks,
    getFileMetadata(path) {
      return opts.metadata?.[path] ?? null;
    },
    resolveLink(linkText, sourcePath) {
      // Trivial resolver: assume linkText IS the resolved path. Tests
      // that need a smarter resolver provide their own metadata.
      const resolved = opts.resolvedLinks[sourcePath]?.[linkText];
      return resolved ? linkText : null;
    },
  };
}

describe('get_backlinks', () => {
  it('returns sources that link to the target with line numbers', async () => {
    const cache = fakeCache({
      resolvedLinks: {
        'sweep.md': { 'pipeline.md': 2 },
        'concierge.md': { 'pipeline.md': 1, 'soltura.md': 1 },
        'unrelated.md': { 'soltura.md': 1 },
      },
      metadata: {
        'sweep.md': {
          links: [
            { link: 'pipeline.md', line: 5 },
            { link: 'pipeline.md', line: 12 },
          ],
          frontmatter: null,
        },
        'concierge.md': {
          links: [
            { link: 'pipeline.md', line: 3 },
            { link: 'soltura.md', line: 7 },
          ],
          frontmatter: null,
        },
      },
    });

    const tool = makeGetBacklinksTool(cache);
    const out = await tool.handler({ path: 'pipeline.md' });

    expect(out.target).toBe('pipeline.md');
    expect(out.total).toBe(2);
    expect(out.inbound).toEqual([
      { path: 'concierge.md', line_numbers: [3] },
      { path: 'sweep.md', line_numbers: [5, 12] },
    ]);
  });

  it('returns empty inbound when nothing links to the target', async () => {
    const cache = fakeCache({
      resolvedLinks: {
        'a.md': { 'b.md': 1 },
      },
    });
    const tool = makeGetBacklinksTool(cache);
    const out = await tool.handler({ path: 'orphan.md' });
    expect(out.inbound).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('returns inbound with empty line_numbers when no per-file metadata is available', async () => {
    const cache = fakeCache({
      resolvedLinks: {
        'src.md': { 'tgt.md': 1 },
      },
      // no metadata entries
    });
    const tool = makeGetBacklinksTool(cache);
    const out = await tool.handler({ path: 'tgt.md' });
    expect(out.inbound).toEqual([{ path: 'src.md', line_numbers: [] }]);
  });

  it('rejects path traversal at the schema boundary', () => {
    const tool = makeGetBacklinksTool(fakeCache({ resolvedLinks: {} }));
    expect(tool.inputSchema.safeParse({ path: '../etc' }).success).toBe(false);
  });
});
