import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '../../src/agent/ToolRegistry';
import { JSON_RPC_ERROR } from '../../src/mcp/JsonRpc';
import { MCP_PROTOCOL_VERSION, McpHandler } from '../../src/mcp/McpHandler';
import type { ToolDefinition } from '../../src/agent/types';

function makeRegistry(tools: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) {
    r.register(t);
  }
  return r;
}

function fakeReadNote(
  result: unknown = { content: 'hello', mtime: 1, hash: 'h' },
): ToolDefinition {
  return {
    name: 'read_note',
    description: 'read a note',
    inputSchema: z.object({ path: z.string() }),
    jsonSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    handler: () => Promise.resolve(result),
  };
}

function makeHandler(registry: ToolRegistry, version = '0.9.0-test'): McpHandler {
  return new McpHandler({
    toolRegistry: registry,
    pluginVersion: version,
    logger: { warn: () => {} },
  });
}

describe('McpHandler', () => {
  it('returns an INVALID_REQUEST error for a malformed body', async () => {
    const h = makeHandler(makeRegistry([]));
    const res = await h.handle('not an object');
    expect('error' in res && res.error.code).toBe(JSON_RPC_ERROR.INVALID_REQUEST);
  });

  it('handles initialize', async () => {
    const h = makeHandler(makeRegistry([]), '0.9.0-x');
    const res = await h.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      expect(res.result).toMatchObject({
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'sagittarius', version: '0.9.0-x' },
        capabilities: { tools: {} },
      });
    }
  });

  it('handles tools/list — returns only the allowlist', async () => {
    const registry = makeRegistry([
      fakeReadNote(),
      {
        name: 'create_note', // write tool, NOT exposed
        description: 'write',
        inputSchema: z.object({}),
        jsonSchema: { type: 'object' },
        handler: () => Promise.resolve('ok'),
      },
    ]);
    const h = makeHandler(registry);
    const res = await h.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const r = res.result as { tools: Array<{ name: string }> };
      expect(r.tools.map((t) => t.name)).toEqual(['read_note']);
    }
  });

  it('handles tools/call — dispatches via the registry', async () => {
    const h = makeHandler(makeRegistry([fakeReadNote({ content: 'NOTE BODY' })]));
    const res = await h.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'a.md' } },
    });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const r = res.result as { content: Array<{ text: string }> };
      expect(r.content[0].text).toContain('NOTE BODY');
    }
  });

  it('rejects tools/call for non-allowlisted tool names', async () => {
    const h = makeHandler(makeRegistry([fakeReadNote()]));
    const res = await h.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'create_note', arguments: {} },
    });
    expect('error' in res && res.error.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
  });

  it('rejects tools/call when name is missing or not a string', async () => {
    const h = makeHandler(makeRegistry([fakeReadNote()]));
    const a = await h.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { arguments: {} },
    });
    expect('error' in a && a.error.code).toBe(JSON_RPC_ERROR.INVALID_PARAMS);
    const b = await h.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 123, arguments: {} },
    });
    expect('error' in b && b.error.code).toBe(JSON_RPC_ERROR.INVALID_PARAMS);
  });

  it('returns isError content when the tool throws (input validation, etc.)', async () => {
    const h = makeHandler(makeRegistry([fakeReadNote()]));
    const res = await h.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      // missing required `path` — Zod validation will throw
      params: { name: 'read_note', arguments: {} },
    });
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const r = res.result as { isError?: boolean; content: Array<{ text: string }> };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('tool error');
    }
  });

  it('returns METHOD_NOT_FOUND for unknown JSON-RPC methods', async () => {
    const h = makeHandler(makeRegistry([]));
    const res = await h.handle({ jsonrpc: '2.0', id: 8, method: 'mystery' });
    expect('error' in res && res.error.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
  });

  it('records activity events with source: mcp:<client> after initialize', async () => {
    const records: Array<Record<string, unknown>> = [];
    const fakeLog = {
      record: (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
        records.push(input);
        return Promise.resolve({ ...input, id: 'x', timestamp: 1 });
      },
      list: () => Promise.resolve([]),
      size: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      clearMatching: () => Promise.resolve(0),
    };
    const h = new McpHandler({
      toolRegistry: makeRegistry([fakeReadNote()]),
      pluginVersion: '0.9.0-test',
      activityLog: fakeLog as never,
      logger: { warn: () => {} },
    });
    // 1) initialize with clientInfo.name → handler captures `mcp:claude-desktop`.
    await h.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'claude-desktop', version: '0.1' } },
    });
    // 2) tools/call → activity event recorded with the captured source.
    await h.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'a.md' } },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'write.committed',
      source: 'mcp:claude-desktop',
      toolName: 'read_note',
      path: 'a.md',
    });
  });

  it('falls back to `source: mcp` when initialize has no clientInfo', async () => {
    const records: Array<Record<string, unknown>> = [];
    const fakeLog = {
      record: (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
        records.push(input);
        return Promise.resolve({ ...input, id: 'x', timestamp: 1 });
      },
      list: () => Promise.resolve([]),
      size: () => Promise.resolve(0),
      clear: () => Promise.resolve(),
      clearMatching: () => Promise.resolve(0),
    };
    const h = new McpHandler({
      toolRegistry: makeRegistry([fakeReadNote()]),
      pluginVersion: '0.9.0-test',
      activityLog: fakeLog as never,
      logger: { warn: () => {} },
    });
    await h.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_note', arguments: { path: 'a.md' } },
    });
    expect(records[0].source).toBe('mcp');
  });

  it('preserves the request id on responses', async () => {
    const h = makeHandler(makeRegistry([]));
    const res = await h.handle({ jsonrpc: '2.0', id: 'abc-123', method: 'initialize' });
    expect(res.id).toBe('abc-123');
  });
});
