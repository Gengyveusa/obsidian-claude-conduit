import { describe, expect, it } from 'vitest';

import { makeGetGraphNeighborhoodTool } from '../../../src/agent/tools/get_graph_neighborhood';
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
    resolveLink(linkText) {
      return linkText;
    },
  };
}

describe('get_graph_neighborhood', () => {
  it('depth=1 returns immediate forward + backward neighbors', async () => {
    const cache = fakeCache({
      resolvedLinks: {
        // origin → out1, out2
        'origin.md': { 'out1.md': 1, 'out2.md': 1 },
        // back1 → origin
        'back1.md': { 'origin.md': 1 },
        // unrelated graph
        'far.md': { 'farther.md': 1 },
      },
    });
    const tool = makeGetGraphNeighborhoodTool(cache);
    const out = await tool.handler({ path: 'origin.md', depth: 1 });

    const paths = out.nodes.map((n) => n.path).sort();
    expect(paths).toEqual(['back1.md', 'origin.md', 'out1.md', 'out2.md']);

    expect(out.nodes.find((n) => n.path === 'origin.md')?.depth).toBe(0);
    expect(out.nodes.find((n) => n.path === 'out1.md')?.depth).toBe(1);
    expect(out.nodes.find((n) => n.path === 'back1.md')?.depth).toBe(1);

    const edgeKeys = out.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(edgeKeys).toEqual([
      'back1.md->origin.md',
      'origin.md->out1.md',
      'origin.md->out2.md',
    ]);
    expect(out.edges.every((e) => e.type === 'wikilink')).toBe(true);
  });

  it('depth=2 explores two hops', async () => {
    const cache = fakeCache({
      resolvedLinks: {
        'a.md': { 'b.md': 1 },
        'b.md': { 'c.md': 1 },
        'c.md': { 'd.md': 1 },
      },
    });
    const tool = makeGetGraphNeighborhoodTool(cache);
    const out = await tool.handler({ path: 'a.md', depth: 2 });
    const paths = out.nodes.map((n) => n.path).sort();
    expect(paths).toEqual(['a.md', 'b.md', 'c.md']);
    // 'd.md' is depth-3 from origin; excluded at depth=2
    expect(paths).not.toContain('d.md');
  });

  it('honors max depth=3 cap', () => {
    const tool = makeGetGraphNeighborhoodTool(fakeCache({ resolvedLinks: {} }));
    expect(tool.inputSchema.safeParse({ path: 'x.md', depth: 4 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ path: 'x.md', depth: 3 }).success).toBe(true);
  });

  it('returns just the origin when it has no neighbors', async () => {
    const cache = fakeCache({ resolvedLinks: {} });
    const tool = makeGetGraphNeighborhoodTool(cache);
    const out = await tool.handler({ path: 'lonely.md', depth: 2 });
    expect(out.nodes).toEqual([{ path: 'lonely.md', depth: 0, title: null }]);
    expect(out.edges).toEqual([]);
  });

  it('extracts title from frontmatter when present', async () => {
    const cache = fakeCache({
      resolvedLinks: {
        'origin.md': { 'titled.md': 1 },
      },
      metadata: {
        'titled.md': { links: [], frontmatter: { title: 'My Title' } },
      },
    });
    const tool = makeGetGraphNeighborhoodTool(cache);
    const out = await tool.handler({ path: 'origin.md', depth: 1 });
    expect(out.nodes.find((n) => n.path === 'titled.md')?.title).toBe('My Title');
  });

  it('default depth is 1', () => {
    const tool = makeGetGraphNeighborhoodTool(fakeCache({ resolvedLinks: {} }));
    expect(tool.inputSchema.parse({ path: 'x.md' }).depth).toBe(1);
  });
});
