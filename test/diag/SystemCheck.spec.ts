import { describe, expect, it, vi } from 'vitest';

import type { MessagesAPI } from '../../src/agent/ConduitAgent';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  SystemCheck,
  type SystemCheckDeps,
  formatReport,
  formatSummary,
} from '../../src/diag/SystemCheck';
import type { EmbedClient } from '../../src/retrieval/EmbedClient';
import type { RetrievalLayer } from '../../src/retrieval/RetrievalLayer';
import type { SqliteEngine } from '../../src/retrieval/SqliteEngine';

class StubAdapter implements VaultAdapter {
  constructor(private readonly mdPaths: string[]) {}
  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }
  read(): Promise<string> {
    return Promise.resolve('');
  }
  readBinary(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  writeBinary(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve(this.mdPaths);
  }
}

function stubEngine(opts: {
  noteCount: number;
  chunkCount: number;
  schemaMeta?: { writer: string; writerVersion: string };
}): SqliteEngine {
  const e = {
    count: vi.fn((table: 'chunks' | 'notes') =>
      table === 'notes' ? opts.noteCount : opts.chunkCount,
    ),
    getSchemaMeta: vi.fn(() => opts.schemaMeta ?? { writer: 'sagittarius', writerVersion: '0.2.4' }),
  };
  return e as unknown as SqliteEngine;
}

function stubEmbedClient(vec: Float32Array | Error): EmbedClient {
  const ec = {
    encode: vi.fn(() => (vec instanceof Error ? Promise.reject(vec) : Promise.resolve(vec))),
  };
  return ec as unknown as EmbedClient;
}

function stubRetrieval(hitCount: number | Error): RetrievalLayer {
  const r = {
    queryUnified: vi.fn(() =>
      hitCount instanceof Error ? Promise.reject(hitCount) : Promise.resolve(new Array(hitCount)),
    ),
  };
  return r as unknown as RetrievalLayer;
}

function stubAnthropicSuccess(): MessagesAPI {
  return {
    create: vi.fn(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    ),
  } as unknown as MessagesAPI;
}

function stubAnthropicFailure(message: string): MessagesAPI {
  return {
    create: vi.fn(() => Promise.reject(new Error(message))),
  };
}

function baseDeps(overrides: Partial<SystemCheckDeps> = {}): SystemCheckDeps {
  const v384 = new Float32Array(384);
  v384[0] = 0.5;
  return {
    manifestVersion: '0.2.4',
    hasAnthropicKey: true,
    hasHuggingFaceKey: true,
    anthropic: stubAnthropicSuccess(),
    defaultModel: 'claude-sonnet-4-6',
    adapter: new StubAdapter(['a.md', 'b.md']),
    engine: stubEngine({ noteCount: 2, chunkCount: 5 }),
    embedClient: stubEmbedClient(v384),
    retrieval: stubRetrieval(1),
    ...overrides,
  };
}

describe('SystemCheck', () => {
  it('returns pass on every check when everything is healthy', async () => {
    const report = await new SystemCheck(baseDeps()).run();
    expect(report.failCount).toBe(0);
    expect(report.warnCount).toBe(0);
    expect(report.passCount).toBe(9);
    const names = report.results.map((r) => r.name);
    expect(names).toEqual([
      'Plugin version',
      'Anthropic API key set',
      'Anthropic API reachable',
      'HuggingFace token set',
      'HF Inference reachable',
      'Vault enumerable',
      'SQLite engine open',
      'Index populated',
      'Retrieval round-trip',
    ]);
  });

  it('fails on malformed manifest version', async () => {
    const report = await new SystemCheck(baseDeps({ manifestVersion: 'not-a-version' })).run();
    const r = report.results.find((x) => x.name === 'Plugin version');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('malformed');
  });

  it('fails on missing Anthropic key', async () => {
    const report = await new SystemCheck(
      baseDeps({ hasAnthropicKey: false, anthropic: null }),
    ).run();
    expect(report.results.find((r) => r.name === 'Anthropic API key set')?.status).toBe('fail');
    expect(report.results.find((r) => r.name === 'Anthropic API reachable')?.status).toBe('fail');
    expect(report.results.find((r) => r.name === 'Anthropic API reachable')?.detail).toContain(
      'no API key',
    );
  });

  it('captures Anthropic API errors without throwing', async () => {
    const report = await new SystemCheck(
      baseDeps({ anthropic: stubAnthropicFailure('401 invalid_api_key') }),
    ).run();
    const r = report.results.find((x) => x.name === 'Anthropic API reachable');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('invalid_api_key');
  });

  it('warns (not fails) when HF token is missing — retrieval is optional', async () => {
    const report = await new SystemCheck(
      baseDeps({
        hasHuggingFaceKey: false,
        embedClient: null,
        retrieval: null,
      }),
    ).run();
    expect(report.results.find((r) => r.name === 'HuggingFace token set')?.status).toBe('warn');
    expect(report.results.find((r) => r.name === 'HF Inference reachable')?.status).toBe('warn');
    expect(report.results.find((r) => r.name === 'Retrieval round-trip')?.status).toBe('warn');
    expect(report.failCount).toBe(0);
  });

  it('fails HF check when the embed client returns wrong-dim vector', async () => {
    const wrongDim = new Float32Array(128);
    const report = await new SystemCheck(baseDeps({ embedClient: stubEmbedClient(wrongDim) })).run();
    const r = report.results.find((x) => x.name === 'HF Inference reachable');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('128-d');
  });

  it('captures HF Inference network errors without throwing', async () => {
    const report = await new SystemCheck(
      baseDeps({ embedClient: stubEmbedClient(new Error('CORS preflight failed')) }),
    ).run();
    const r = report.results.find((x) => x.name === 'HF Inference reachable');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('CORS preflight failed');
  });

  it('fails Vault enumerable when listAllMarkdown returns []', async () => {
    const report = await new SystemCheck(baseDeps({ adapter: new StubAdapter([]) })).run();
    const r = report.results.find((x) => x.name === 'Vault enumerable');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('0 markdown files');
  });

  it('warns when index is empty (chunks=0) but engine is open', async () => {
    const report = await new SystemCheck(
      baseDeps({ engine: stubEngine({ noteCount: 0, chunkCount: 0 }) }),
    ).run();
    const ip = report.results.find((r) => r.name === 'Index populated');
    expect(ip?.status).toBe('warn');
    expect(ip?.detail).toContain('Build Index');
    const rt = report.results.find((r) => r.name === 'Retrieval round-trip');
    expect(rt?.status).toBe('warn');
    expect(rt?.detail).toContain('index empty');
  });

  it('captures retrieval round-trip errors without throwing', async () => {
    const report = await new SystemCheck(
      baseDeps({ retrieval: stubRetrieval(new Error('sql: no such column')) }),
    ).run();
    const r = report.results.find((x) => x.name === 'Retrieval round-trip');
    expect(r?.status).toBe('fail');
    expect(r?.detail).toContain('no such column');
  });
});

describe('formatSummary', () => {
  it('renders the all-green case', () => {
    const summary = formatSummary({
      results: [],
      totalMs: 2100,
      passCount: 9,
      warnCount: 0,
      failCount: 0,
    });
    expect(summary).toBe('Sagittarius system check: ✅ 9/9 passed in 2.1s');
  });

  it('renders mixed pass/warn', () => {
    const summary = formatSummary({
      results: [],
      totalMs: 1800,
      passCount: 6,
      warnCount: 3,
      failCount: 0,
    });
    expect(summary).toContain('⚠️');
    expect(summary).toContain('6/9 passed');
    expect(summary).toContain('3 warn');
  });

  it('renders fail case', () => {
    const summary = formatSummary({
      results: [],
      totalMs: 500,
      passCount: 7,
      warnCount: 1,
      failCount: 1,
    });
    expect(summary).toContain('❌');
    expect(summary).toContain('1 warn');
    expect(summary).toContain('1 fail');
  });
});

describe('formatReport', () => {
  it('outputs one line per check with icons and padding', () => {
    const out = formatReport({
      results: [
        { name: 'A', status: 'pass', durationMs: 12, detail: 'ok' },
        { name: 'B', status: 'warn', durationMs: 5, detail: 'skipped' },
        { name: 'C', status: 'fail', durationMs: 800, detail: 'boom' },
      ],
      totalMs: 817,
      passCount: 1,
      warnCount: 1,
      failCount: 1,
    });
    const lines = out.split('\n');
    expect(lines[0]).toContain('System check report');
    expect(lines[1]).toContain('✅');
    expect(lines[2]).toContain('⚠️');
    expect(lines[3]).toContain('❌');
    expect(lines[3]).toContain('boom');
  });
});
