import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  MCP_HIGH_RISK_TOOL_NAMES,
  MCP_READ_TOOL_NAMES,
  MCP_WRITE_TOOL_NAMES,
  isMcpExposed,
  isMcpHighRiskTool,
  isMcpReadTool,
  isMcpWriteTool,
  mcpExposedToolNames,
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

const READ_ONLY_EXPOSURE = mcpExposedToolNames({
  writeEnabled: false,
  highRiskEnabled: false,
});

const WRITE_ENABLED_EXPOSURE = mcpExposedToolNames({
  writeEnabled: true,
  highRiskEnabled: false,
});

const FULL_EXPOSURE = mcpExposedToolNames({
  writeEnabled: true,
  highRiskEnabled: true,
});

describe('mcpExposedToolNames', () => {
  it('returns the 5 read tools when write-side is off', () => {
    expect([...READ_ONLY_EXPOSURE].sort()).toEqual([...MCP_READ_TOOL_NAMES].sort());
  });

  it('adds the 9 non-high-risk write tools when writeEnabled', () => {
    const expected = new Set<string>([...MCP_READ_TOOL_NAMES, ...MCP_WRITE_TOOL_NAMES]);
    expect(WRITE_ENABLED_EXPOSURE).toEqual(expected);
  });

  it('adds delete_note only when both writeEnabled and highRiskEnabled', () => {
    expect(FULL_EXPOSURE.has('delete_note')).toBe(true);
    expect(WRITE_ENABLED_EXPOSURE.has('delete_note')).toBe(false);
  });

  it('ignores highRiskEnabled when writeEnabled is off', () => {
    const exposure = mcpExposedToolNames({ writeEnabled: false, highRiskEnabled: true });
    expect(exposure.has('delete_note')).toBe(false);
    expect(exposure.has('create_note')).toBe(false);
  });
});

describe('isMcpExposed', () => {
  it('returns true for each read-only tool against the read-only exposure', () => {
    for (const name of MCP_READ_TOOL_NAMES) {
      expect(isMcpExposed(name, READ_ONLY_EXPOSURE)).toBe(true);
    }
  });

  it('returns false for write tools against the read-only exposure', () => {
    for (const name of ['create_note', 'move_note', 'patch_note', 'link_notes']) {
      expect(isMcpExposed(name, READ_ONLY_EXPOSURE)).toBe(false);
    }
  });

  it('returns true for write tools against the write-enabled exposure', () => {
    for (const name of MCP_WRITE_TOOL_NAMES) {
      expect(isMcpExposed(name, WRITE_ENABLED_EXPOSURE)).toBe(true);
    }
  });

  it('returns false for unknown names regardless of exposure', () => {
    expect(isMcpExposed('mystery_tool', FULL_EXPOSURE)).toBe(false);
  });
});

describe('isMcpReadTool / isMcpWriteTool / isMcpHighRiskTool', () => {
  it('classifies read tools', () => {
    expect(isMcpReadTool('read_note')).toBe(true);
    expect(isMcpWriteTool('read_note')).toBe(false);
    expect(isMcpHighRiskTool('read_note')).toBe(false);
  });

  it('classifies non-high-risk write tools', () => {
    expect(isMcpReadTool('create_note')).toBe(false);
    expect(isMcpWriteTool('create_note')).toBe(true);
    expect(isMcpHighRiskTool('create_note')).toBe(false);
  });

  it('classifies delete_note as high-risk write', () => {
    expect(isMcpReadTool('delete_note')).toBe(false);
    expect(isMcpWriteTool('delete_note')).toBe(true);
    expect(isMcpHighRiskTool('delete_note')).toBe(true);
  });

  it('exposes the high-risk set as exactly [delete_note] for v1.0.9', () => {
    expect([...MCP_HIGH_RISK_TOOL_NAMES]).toEqual(['delete_note']);
  });
});

describe('mcpToolListFrom', () => {
  it('keeps only tools in the supplied exposure set', () => {
    const tools = [
      fakeTool('read_note'),
      fakeTool('list_folder'),
      fakeTool('search_vault'),
      fakeTool('get_backlinks'),
      fakeTool('get_graph_neighborhood'),
      fakeTool('create_note'),
      fakeTool('move_note'),
    ];
    const out = mcpToolListFrom(tools, READ_ONLY_EXPOSURE);
    expect(out.map((t) => t.name)).toEqual([
      'read_note',
      'list_folder',
      'search_vault',
      'get_backlinks',
      'get_graph_neighborhood',
    ]);
  });

  it('reshapes into the MCP tool format', () => {
    const out = mcpToolListFrom([fakeTool('read_note')], READ_ONLY_EXPOSURE);
    expect(out[0]).toEqual({
      name: 'read_note',
      description: 'the read_note tool',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    });
  });

  it('returns empty when no exposed tools are present', () => {
    const out = mcpToolListFrom([fakeTool('create_note')], READ_ONLY_EXPOSURE);
    expect(out).toEqual([]);
  });

  it('includes write tools when the exposure set permits', () => {
    const out = mcpToolListFrom(
      [fakeTool('read_note'), fakeTool('create_note'), fakeTool('delete_note')],
      FULL_EXPOSURE,
    );
    expect(out.map((t) => t.name).sort()).toEqual(['create_note', 'delete_note', 'read_note']);
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
