import type { ToolDefinition } from '../agent/types';

/**
 * Phase 6.5 (v0.9.0 PR 3) — bridge between our `ToolRegistry` and the
 * MCP `tools/list` + `tools/call` surface per ADR-021 D9.
 *
 * Per D1 (c) the v0.9.0 bridge exposes the five read-only tools only:
 * `read_note`, `list_folder`, `search_vault`, `get_backlinks`,
 * `get_graph_neighborhood`. Phase 4 write tools stay registered with
 * our `ToolRegistry` for the in-app agent, but the MCP allowlist
 * filters them out at the boundary.
 *
 * Pure functions — no I/O. Caller composes them with `ToolRegistry`.
 */

/** Whitelist of tool names exposed over MCP in v0.9.0 (ADR-021 D1 + D9). */
export const MCP_EXPOSED_TOOL_NAMES = [
  'read_note',
  'list_folder',
  'search_vault',
  'get_backlinks',
  'get_graph_neighborhood',
] as const;

export type McpExposedToolName = (typeof MCP_EXPOSED_TOOL_NAMES)[number];

/** Single tool entry as MCP clients expect it in `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

/** Single content item in an MCP `tools/call` response. */
export interface McpToolCallContent {
  type: 'text';
  text: string;
}

/** Result of a `tools/call`. */
export interface McpToolCallResult {
  content: McpToolCallContent[];
  isError?: boolean;
}

/**
 * Filter a `ToolDefinition[]` (e.g. `toolRegistry.list()`) down to the
 * MCP allowlist + reshape into the MCP tool format. Drops anything
 * not in `MCP_EXPOSED_TOOL_NAMES`.
 */
export function mcpToolListFrom(
  tools: ReadonlyArray<ToolDefinition>,
): McpToolDefinition[] {
  const allowed = new Set<string>(MCP_EXPOSED_TOOL_NAMES);
  const out: McpToolDefinition[] = [];
  for (const tool of tools) {
    if (!allowed.has(tool.name)) {
      continue;
    }
    out.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    });
  }
  return out;
}

/**
 * True if `name` is one of the MCP-exposed read-only tools. Used by
 * the dispatcher to reject `tools/call` for non-allowlisted names
 * (returns `Method not found`-style error).
 */
export function isMcpExposed(name: string): boolean {
  return (MCP_EXPOSED_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Wrap an arbitrary tool result into MCP `tools/call` content shape.
 * Strings pass through as text; objects/arrays are JSON-stringified.
 * Null/undefined become an empty-string text item.
 *
 * MCP spec allows multiple content items but our read-only tools each
 * return a single logical value, so we always emit one.
 */
export function wrapToolResult(result: unknown, isError = false): McpToolCallResult {
  let text: string;
  if (result === null || result === undefined) {
    text = '';
  } else if (typeof result === 'string') {
    text = result;
  } else {
    text = JSON.stringify(result, null, 2);
  }
  return {
    content: [{ type: 'text', text }],
    ...(isError && { isError: true }),
  };
}
