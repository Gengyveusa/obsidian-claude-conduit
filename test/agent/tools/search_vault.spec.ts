import { describe, expect, it, vi } from 'vitest';

import type { RetrievalLayer } from '../../../src/retrieval/RetrievalLayer';
import { makeSearchVaultTool } from '../../../src/agent/tools/search_vault';

function fakeRetrieval(handler: RetrievalLayer['queryUnified']): RetrievalLayer {
  return { queryUnified: handler } as unknown as RetrievalLayer;
}

describe('search_vault', () => {
  it('passes input through to RetrievalLayer.queryUnified with translated keys', async () => {
    const queryUnified = vi.fn().mockResolvedValue([]);
    const tool = makeSearchVaultTool(fakeRetrieval(queryUnified));
    await tool.handler({
      query: 'soltura',
      limit: 5,
      source_db: 'corpus',
      filter_path_prefix: '41-Soltura/',
    });
    expect(queryUnified).toHaveBeenCalledWith({
      query: 'soltura',
      limit: 5,
      sourceDb: 'corpus',
      filterPathPrefix: '41-Soltura/',
    });
  });

  it('translates RetrievalLayer camelCase results to snake_case output', async () => {
    const queryUnified = vi.fn().mockResolvedValue([
      {
        path: 'a.md',
        chunk: 0,
        title: null,
        source: null,
        doctrine: null,
        score: 0.91,
        text: 'snippet',
        sourceDb: 'self' as const,
      },
    ]);
    const tool = makeSearchVaultTool(fakeRetrieval(queryUnified));
    const out = await tool.handler({ query: 'q', limit: 8, source_db: 'both' });
    expect(out).toEqual([
      {
        path: 'a.md',
        chunk: 0,
        title: null,
        source: null,
        doctrine: null,
        score: 0.91,
        text: 'snippet',
        source_db: 'self',
      },
    ]);
  });

  it('rejects empty query at the schema boundary', () => {
    const tool = makeSearchVaultTool(fakeRetrieval(vi.fn()));
    expect(tool.inputSchema.safeParse({ query: '' }).success).toBe(false);
  });

  it('rejects limit > 100', () => {
    const tool = makeSearchVaultTool(fakeRetrieval(vi.fn()));
    expect(tool.inputSchema.safeParse({ query: 'x', limit: 150 }).success).toBe(false);
  });

  it('default limit is 8 and source_db is both', () => {
    const tool = makeSearchVaultTool(fakeRetrieval(vi.fn()));
    const parsed = tool.inputSchema.parse({ query: 'x' });
    expect(parsed.limit).toBe(8);
    expect(parsed.source_db).toBe('both');
  });
});
