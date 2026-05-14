import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MCP_EXPOSED_TOOL_NAMES,
  isMcpExposed,
  mcpToolListFrom,
  wrapToolResult,
} from '../../src/mcp/McpToolAdapter';
import type { ToolDefinition } from '../../src/agent/types';

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: z.object({ x: z.string() }),
    jsonSchema: { type: 'object', properties: { x: { type: 'string' } } },
    handler: () => Promise.resolve('ok'),
  };
}

describe('isMcpExposed', () => {
  it('returns true for each of the 5 read-only tools', () => {
    for (const name of MCP_EXPOSED_TOOL_NAMES) {
      expect(isMcpExposed(name)).toBe(true);
    }
  });

  it('returns false for write tools', () => {
    for (const name of ['create_note', 'move_note', 'patch_note', 'link_notes']) {
      expect(isMcpExposed(name)).toBe(false);
    }
  });

  it('returns false for unknown names', () => {
    expect(isMcpExposed('mystery_tool')).toBe(false);
  });
});

describe('mcpToolListFrom', () => {
  it('keeps only the 5 read-only allowlisted tools', () => {
    const tools = [
      fakeTool('read_note'),
      fakeTool('list_folder'),
      fakeTool('search_vault'),
      fakeTool('get_backlinks'),
      fakeTool('get_graph_neighborhood'),
      fakeTool('create_note'),
      fakeTool('move_note'),
    ];
    const out = mcpToolListFrom(tools);
    expect(out.map((t) => t.name)).toEqual([
      'read_note',
      'list_folder',
      'search_vault',
      'get_backlinks',
      'get_graph_neighborhood',
    ]);
  });

  it('reshapes into the MCP tool format', () => {
    const out = mcpToolListFrom([fakeTool('read_note')]);
    expect(out[0]).toEqual({
      name: 'read_note',
      description: 'the read_note tool',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    });
  });

  it('returns empty when no allowlisted tools are present', () => {
    const out = mcpToolListFrom([fakeTool('create_note')]);
    expect(out).toEqual([]);
  });
});

describe('wrapToolResult', () => {
  it('passes strings through as a single text content item', () => {
    expect(wrapToolResult('plain string')).toEqual({
      content: [{ type: 'text', text: 'plain string' }],
    });
  });

  it('JSON-stringifies objects', () => {
    const result = wrapToolResult({ files: ['a.md', 'b.md'] });
    expect(result.content[0].text).toContain('"files"');
    expect(result.content[0].text).toContain('"a.md"');
  });

  it('handles null/undefined as empty string', () => {
    expect(wrapToolResult(null).content[0].text).toBe('');
    expect(wrapToolResult(undefined).content[0].text).toBe('');
  });

  it('attaches isError when set', () => {
    const result = wrapToolResult('boom', true);
    expect(result.isError).toBe(true);
  });

  it('omits isError when not set', () => {
    const result = wrapToolResult('ok');
    expect(result.isError).toBeUndefined();
  });
});
