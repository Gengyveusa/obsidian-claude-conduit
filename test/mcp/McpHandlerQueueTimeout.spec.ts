import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ActivityLog } from '../../src/activity/ActivityLog';
import type { ActivityEvent, ActivityEventInput } from '../../src/activity/types';
import type { ToolDefinition, VaultAdapter, VaultStat } from '../../src/agent/types';
import { ToolRegistry } from '../../src/agent/ToolRegistry';
import { McpHandler } from '../../src/mcp/McpHandler';
import { CallbackApprovalGate } from '../../src/writes/CallbackApprovalGate';
import { ExternalProposalQueue } from '../../src/writes/ExternalProposalQueue';
import { JsonTransactionLog } from '../../src/writes/TransactionLog';
import { WriteToolContext } from '../../src/writes/WriteToolContext';
import type { AppliedOp, Proposal } from '../../src/writes/types';

/**
 * Tests for ADR-025 D2 (c) hybrid block-then-queue. The MCP handler
 * should:
 *   - Respond synchronously when the user approves within
 *     `mcpWriteQueueTimeoutMs`.
 *   - Respond `'queued'` when the timeout fires first, with the
 *     background promise eventually committing once the user
 *     responds via the side panel.
 */

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    return this.files.has(p)
      ? Promise.resolve(this.files.get(p) ?? '')
      : Promise.reject(new Error(`ENOENT: ${p}`));
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
      timestamp: 1,
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
 * Fake create_note that goes through the supplied gate, mirroring the
 * real tool's structure. apply() bumps a counter so the test can prove
 * the write actually happened after the user approves.
 */
function fakeCreateNote(
  gate: CallbackApprovalGate,
  ctx: WriteToolContext,
  applyCounter: { count: number },
): ToolDefinition {
  return {
    name: 'create_note',
    description: 'fake create',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    handler: async (input: unknown) => {
      const { path } = input as { path: string };
      const proposal: Proposal = {
        toolName: 'create_note',
        args: input as Record<string, unknown>,
        diff: { kind: 'create-file', path, content: 'x' },
        apply: () => {
          applyCounter.count += 1;
          const op: AppliedOp = {
            toolName: 'create_note',
            path,
            appliedAt: 1,
            inverse: { kind: 'delete-file', path },
          };
          ctx.record(op);
          return Promise.resolve(op);
        },
      };
      const decision = await gate.request(proposal);
      if (decision.kind === 'reject') {
        return { status: 'rejected', path };
      }
      await proposal.apply();
      return { status: 'applied', path };
    },
  };
}

interface Harness {
  handler: McpHandler;
  ctx: WriteToolContext;
  queue: ExternalProposalQueue;
  txLog: JsonTransactionLog;
  applyCounter: { count: number };
}

function makeHarness(opts: { queueTimeoutMs: number }): Harness {
  const adapter = new MemAdapter();
  const activity = new RecordingActivityLog();
  const txLog = new JsonTransactionLog({
    adapter,
    path: '.obsidian/plugins/x/tx.json',
    activityLog: activity,
  });
  const ctx = new WriteToolContext(txLog);
  const queue = new ExternalProposalQueue({
    now: () => 1,
    randId: () => 'aaa',
  });
  const gate = new CallbackApprovalGate({ ctx, externalQueue: queue });
  const applyCounter = { count: 0 };
  const registry = new ToolRegistry();
  registry.register(fakeCreateNote(gate, ctx, applyCounter));
  const handler = new McpHandler({
    toolRegistry: registry,
    pluginVersion: 'test',
    activityLog: activity,
    writeContext: ctx,
    logger: { warn: () => {} },
    clock: () => 1,
    writeSettings: () => ({
      mcpWriteEnabled: true,
      mcpHighRiskToolsEnabled: false,
      mcpWriteAllowedClients: [],
      mcpWritePathPrefixes: ['10-Inbox/'],
      mcpWriteRateLimitPerHour: 0,
      mcpWriteQueueTimeoutMs: opts.queueTimeoutMs,
    }),
  });
  return { handler, ctx, queue, txLog, applyCounter };
}

async function initialize(h: Harness, clientName = 'claude-desktop'): Promise<void> {
  await h.handler.handle({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { clientInfo: { name: clientName } },
  });
}

describe('McpHandler queue-timeout race (ADR-025 D2 hybrid)', () => {
  it('responds synchronously when the user approves before the timeout', async () => {
    const h = makeHarness({ queueTimeoutMs: 1000 });
    await initialize(h);
    const responsePromise = h.handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/a.md', content: 'x' } },
    });
    // Yield so the tool enqueues. Then approve.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.queue.size()).toBe(1);
    h.queue.respond(h.queue.pending()[0].id, { kind: 'accept' });

    const res = (await responsePromise) as { result?: { content: Array<{ text: string }> } };
    expect(res.result).toBeDefined();
    const text = res.result!.content[0].text;
    // Synchronous success — NOT 'queued'.
    expect(text).not.toContain('queued');
    expect(text).toContain('applied');
    expect(h.applyCounter.count).toBe(1);
    // Transaction committed with the source.
    const recent = await h.txLog.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].source).toBe('mcp:claude-desktop');
  });

  it('responds queued when the timeout fires before the user approves', async () => {
    // 5ms timeout — race fires before respond() is called.
    const h = makeHarness({ queueTimeoutMs: 5 });
    await initialize(h);
    const responsePromise = h.handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/b.md', content: 'y' } },
    });
    const res = (await responsePromise) as { result?: { content: Array<{ text: string }> } };
    const text = res.result!.content[0].text;
    expect(text).toContain('queued');
    expect(h.queue.size()).toBe(1); // entry remains alive after timeout
    expect(h.applyCounter.count).toBe(0); // no apply yet
  });

  it('the background tool still commits when the user responds AFTER the timeout', async () => {
    const h = makeHarness({ queueTimeoutMs: 5 });
    await initialize(h);
    const responsePromise = h.handler.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/c.md', content: 'z' } },
    });
    await responsePromise; // MCP returned 'queued'

    // User approves later via the side panel.
    h.queue.respond(h.queue.pending()[0].id, { kind: 'accept' });
    // Yield to let the background IIFE finish writeContext.end().
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(h.applyCounter.count).toBe(1);
    const recent = await h.txLog.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].source).toBe('mcp:claude-desktop');
    expect(recent[0].ops[0].path).toBe('10-Inbox/c.md');
  });

  it('the background tool abandons when the user rejects', async () => {
    const h = makeHarness({ queueTimeoutMs: 5 });
    await initialize(h);
    const responsePromise = h.handler.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/d.md', content: 'w' } },
    });
    await responsePromise;

    h.queue.respond(h.queue.pending()[0].id, { kind: 'reject', reason: 'no' });
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(h.applyCounter.count).toBe(0);
    // No transaction committed because no op recorded.
    const recent = await h.txLog.recent();
    expect(recent).toEqual([]);
  });

  it('queueTimeoutMs = 0 falls back to pure synchronous block', async () => {
    const h = makeHarness({ queueTimeoutMs: 0 });
    await initialize(h);
    const responsePromise = h.handler.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { path: '10-Inbox/sync.md', content: '!' } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.queue.size()).toBe(1);
    h.queue.respond(h.queue.pending()[0].id, { kind: 'accept' });
    const res = (await responsePromise) as { result?: { content: Array<{ text: string }> } };
    expect(res.result!.content[0].text).toContain('applied');
    // No 'queued' branch.
    expect(res.result!.content[0].text).not.toContain('queued');
  });
});
