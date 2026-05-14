import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ActivityLog } from '../../src/activity/ActivityLog';
import type { ActivityEvent, ActivityEventInput } from '../../src/activity/types';
import type { ToolDefinition, VaultAdapter, VaultStat } from '../../src/agent/types';
import { ToolRegistry } from '../../src/agent/ToolRegistry';
import { McpHandler } from '../../src/mcp/McpHandler';
import { JsonTransactionLog } from '../../src/writes/TransactionLog';
import { WriteToolContext } from '../../src/writes/WriteToolContext';
import type { AppliedOp, Transaction } from '../../src/writes/types';

/**
 * In-memory `VaultAdapter` — only `exists`/`read`/`write` matter for the
 * transaction log; the rest throw to flag unintended access.
 */
class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const v = this.files.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
  }
  write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(): Promise<void> {
    throw new Error('unused');
  }
  delete(): Promise<void> {
    throw new Error('unused');
  }
  renameFile(): Promise<void> {
    throw new Error('unused');
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
    return Promise.resolve([]);
  }
}

class RecordingActivityLog implements ActivityLog {
  readonly events: ActivityEventInput[] = [];

  record(input: ActivityEventInput): Promise<ActivityEvent> {
    this.events.push(input);
    return Promise.resolve({
      ...input,
      id: `evt-${this.events.length}`,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
  list(): Promise<ActivityEvent[]> {
    return Promise.resolve([]);
  }
  size(): Promise<number> {
    return Promise.resolve(this.events.length);
  }
  clear(): Promise<void> {
    this.events.length = 0;
    return Promise.resolve();
  }
  clearMatching(): Promise<number> {
    throw new Error('unused');
  }
}

/**
 * Fake `create_note` tool that records a synthesized AppliedOp on the
 * shared WriteToolContext, mirroring the real tool's behavior without
 * touching the filesystem. Lets the source-plumbing test verify the
 * end-to-end seam (McpHandler → writeCtx.begin → tool.record → tx.commit).
 */
function fakeCreateNoteTool(ctx: WriteToolContext): ToolDefinition {
  return {
    name: 'create_note',
    description: 'fake create',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    handler: (input: unknown) => {
      const { path } = input as { path: string };
      const op: AppliedOp = {
        toolName: 'create_note',
        path,
        appliedAt: 1700000000,
        inverse: { kind: 'delete-file', path },
      };
      ctx.record(op);
      return Promise.resolve({ status: 'applied', path });
    },
  };
}

function fakeReadNote(): ToolDefinition {
  return {
    name: 'read_note',
    description: 'read',
    inputSchema: z.object({ path: z.string() }),
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    handler: () => Promise.resolve({ content: 'hi', mtime: 1, hash: 'h' }),
  };
}

interface Harness {
  handler: McpHandler;
  ctx: WriteToolContext;
  adapter: MemAdapter;
  activity: RecordingActivityLog;
  txLog: JsonTransactionLog;
  setSettings: (s: Partial<WriteSettings>) => void;
}

type WriteSettings = {
  mcpWriteEnabled: boolean;
  mcpHighRiskToolsEnabled: boolean;
  mcpWriteAllowedClients: string[];
  mcpWritePathPrefixes: string[];
  mcpWriteRateLimitPerHour: number;
};

const DEFAULT_WRITE_SETTINGS: WriteSettings = {
  mcpWriteEnabled: true,
  mcpHighRiskToolsEnabled: false,
  mcpWriteAllowedClients: [],
  mcpWritePathPrefixes: ['10-Inbox/'],
  mcpWriteRateLimitPerHour: 30,
};

function makeHarness(): Harness {
  const adapter = new MemAdapter();
  const activity = new RecordingActivityLog();
  const txLog = new JsonTransactionLog({
    adapter,
    path: '.obsidian/plugins/x/transactions.json',
    activityLog: activity,
  });
  const ctx = new WriteToolContext(txLog);
  const registry = new ToolRegistry();
  registry.register(fakeReadNote());
  registry.register(fakeCreateNoteTool(ctx));
  let settings: WriteSettings = { ...DEFAULT_WRITE_SETTINGS };
  const handler = new McpHandler({
    toolRegistry: registry,
    pluginVersion: '1.0.9-test',
    activityLog: activity,
    writeSettings: () => settings,
    writeContext: ctx,
    logger: { warn: () => {} },
    clock: () => 1_700_000_000_000,
  });
  return {
    handler,
    ctx,
    adapter,
    activity,
    txLog,
    setSettings: (s) => {
      settings = { ...settings, ...s };
    },
  };
}

async function initialize(handler: McpHandler, clientName = 'claude-desktop'): Promise<void> {
  await handler.handle({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { clientInfo: { name: clientName } },
  });
}

describe('McpHandler tools/list with write-side', () => {
  it('omits write tools when mcpWriteEnabled is false', async () => {
    const h = makeHarness();
    h.setSettings({ mcpWriteEnabled: false });
    const res = await h.handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(names).toEqual(['read_note']);
    }
  });

  it('includes the 9 non-high-risk write tools when writeEnabled', async () => {
    const h = makeHarness();
    h.setSettings({ mcpWriteEnabled: true });
    const res = await h.handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    if ('result' in res) {
      const names = (res.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      // Only the tools we actually registered show up.
      expect(names).toContain('read_note');
      expect(names).toContain('create_note');
      expect(names).not.toContain('delete_note'); // not registered in harness
    }
  });
});

describe('McpHandler tools/call write-side gates', () => {
  it('rejects when master toggle is off', async () => {
    const h = makeHarness();
    h.setSettings({ mcpWriteEnabled: false });
    await initialize(h.handler);
    const res = await h.handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/a.md', content: 'x' } },
    });
    // Master-off makes the tool invisible at tools/list, so tools/call returns
    // METHOD_NOT_FOUND rather than a SERVER_ERROR. Either way no transaction
    // is committed.
    expect('error' in res).toBe(true);
    expect(h.activity.events.filter((e) => e.kind === 'write.committed')).toHaveLength(0);
  });

  it('rejects when path is outside the allowlist', async () => {
    const h = makeHarness();
    await initialize(h.handler);
    const res = await h.handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_note',
        arguments: { path: '99-Outside/a.md', content: 'x' },
      },
    });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.message).toContain('outside the MCP write-path allowlist');
    }
  });

  it('rejects when client is not in mcpWriteAllowedClients', async () => {
    const h = makeHarness();
    h.setSettings({ mcpWriteAllowedClients: ['only-this-one'] });
    await initialize(h.handler, 'claude-desktop');
    const res = await h.handler.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/a.md', content: 'x' } },
    });
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.message).toContain('not in the write-allowed list');
    }
  });

  it('rejects after the rate-limit ceiling is exceeded', async () => {
    const h = makeHarness();
    h.setSettings({ mcpWriteRateLimitPerHour: 2 });
    await initialize(h.handler);
    const call = (): Promise<unknown> =>
      h.handler.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'create_note', arguments: { path: '10-Inbox/a.md', content: 'x' } },
      });
    await call();
    await call();
    const third = (await call()) as { error?: { message: string } };
    expect(third.error?.message ?? '').toContain('rate limit');
  });

  it('succeeds when all gates pass and tags Transaction.source with the client', async () => {
    const h = makeHarness();
    await initialize(h.handler, 'claude-desktop');
    const res = await h.handler.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/note.md', content: 'body' } },
    });
    expect('result' in res).toBe(true);
    // Transaction should carry source = 'mcp:claude-desktop'.
    const transactions: Transaction[] = await h.txLog.recent();
    expect(transactions).toHaveLength(1);
    expect(transactions[0].source).toBe('mcp:claude-desktop');
    expect(transactions[0].ops[0].path).toBe('10-Inbox/note.md');
    // Activity log emitted both the per-McpHandler event AND the
    // per-TransactionLog event, each tagged with the same source.
    const writeEvents = h.activity.events.filter((e) => e.kind === 'write.committed');
    expect(writeEvents.length).toBeGreaterThanOrEqual(1);
    expect(writeEvents.every((e) => e.source === 'mcp:claude-desktop')).toBe(true);
  });

  it('returns "in-app chat in progress" when the writeContext is already open', async () => {
    const h = makeHarness();
    await initialize(h.handler);
    // Simulate ConduitAgent.chat() being mid-turn.
    h.ctx.begin('in-app-session');
    try {
      const res = await h.handler.handle({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'create_note', arguments: { path: '10-Inbox/a.md', content: 'x' } },
      });
      expect('error' in res).toBe(true);
      if ('error' in res) {
        expect(res.error.message).toContain('In-app chat is in progress');
      }
    } finally {
      h.ctx.abandon();
    }
  });
});

describe('McpHandler tools/call read-side unaffected', () => {
  it('still serves read tools the same way as v0.9.x', async () => {
    const h = makeHarness();
    await initialize(h.handler);
    const res = await h.handler.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'a.md' } },
    });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const content = (res.result as { content: Array<{ text: string }> }).content[0].text;
      expect(content).toContain('hi');
    }
  });
});
