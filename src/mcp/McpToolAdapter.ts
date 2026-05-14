import type { ToolDefinition } from '../agent/types';

/**
 * Phase 6.5 (v0.9.0 PR 3) — bridge between our `ToolRegistry` and the
 * MCP `tools/list` + `tools/call` surface per ADR-021 D9, extended in
 * v1.0.9 per ADR-025 (Phase 6.7) to add the write tools behind explicit
 * user opt-in toggles.
 *
 * Read tools (always exposed when the bridge is enabled):
 *   `read_note`, `list_folder`, `search_vault`, `get_backlinks`,
 *   `get_graph_neighborhood`.
 *
 * Write tools (exposed only when `mcpWriteEnabled`):
 *   `create_note`, `append_to_note`, `patch_note`, `rewrite_section`,
 *   `add_frontmatter`, `move_note`, `rename_note`, `link_notes`,
 *   `file_asset`. The destructive `delete_note` requires a second
 *   toggle (`mcpHighRiskToolsEnabled`) per ADR-025 D1.
 *
 * Pure functions — no I/O. Caller composes them with `ToolRegistry`.
 */

/** Read-only tools per ADR-021 D1 — exposed whenever the bridge is up. */
export const MCP_READ_TOOL_NAMES = [
  'read_note',
  'list_folder',
  'search_vault',
  'get_backlinks',
  'get_graph_neighborhood',
] as const;

/**
 * Write tools per ADR-025 D1 (excluding the high-risk `delete_note`,
 * which requires a separate toggle). All routes through the diff card
 * via the existing `CallbackApprovalGate`.
 */
export const MCP_WRITE_TOOL_NAMES = [
  'create_note',
  'append_to_note',
  'patch_note',
  'rewrite_section',
  'add_frontmatter',
  'move_note',
  'rename_note',
  'link_notes',
  'file_asset',
] as const;

/** High-risk write tools per ADR-025 D1 — gated behind a second toggle. */
export const MCP_HIGH_RISK_TOOL_NAMES = ['delete_note'] as const;

/**
 * Compute the full exposure set for the current settings. Returns a
 * `ReadonlySet<string>` for O(1) membership tests in `mcpToolListFrom`
 * and `isMcpExposed`.
 *
 * @example
 *   const exposed = mcpExposedToolNames({
 *     writeEnabled: settings.mcpWriteEnabled,
 *     highRiskEnabled: settings.mcpHighRiskToolsEnabled,
 *   });
 *   const tools = mcpToolListFrom(registry.definitions(), exposed);
 */
export function mcpExposedToolNames(opts: {
  writeEnabled: boolean;
  highRiskEnabled: boolean;
}): ReadonlySet<string> {
  const out = new Set<string>(MCP_READ_TOOL_NAMES);
  if (opts.writeEnabled) {
    for (const name of MCP_WRITE_TOOL_NAMES) {
      out.add(name);
    }
    if (opts.highRiskEnabled) {
      for (const name of MCP_HIGH_RISK_TOOL_NAMES) {
        out.add(name);
      }
    }
  }
  return out;
}

/** True if `name` is one of the always-on read tools. */
export function isMcpReadTool(name: string): boolean {
  return (MCP_READ_TOOL_NAMES as readonly string[]).includes(name);
}

/** True if `name` is any MCP-exposed write tool (read tools return false). */
export function isMcpWriteTool(name: string): boolean {
  return (
    (MCP_WRITE_TOOL_NAMES as readonly string[]).includes(name) ||
    (MCP_HIGH_RISK_TOOL_NAMES as readonly string[]).includes(name)
  );
}

/** True if `name` is in the high-risk tier per ADR-025 D1. */
export function isMcpHighRiskTool(name: string): boolean {
  return (MCP_HIGH_RISK_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * @deprecated Use {@link mcpExposedToolNames} with the current settings.
 * Kept for the read-only test fixtures that pre-date v1.0.9; new code
 * should compute exposure dynamically.
 */
export const MCP_EXPOSED_TOOL_NAMES = MCP_READ_TOOL_NAMES;

export type McpExposedToolName = (typeof MCP_READ_TOOL_NAMES)[number];

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
 * Filter a `ToolDefinition[]` (e.g. `toolRegistry.definitions()`) down
 * to the supplied exposure set and reshape into the MCP tool format.
 * Caller computes the exposure set via `mcpExposedToolNames(settings)`
 * each call so settings flips reflect immediately without server
 * restart.
 */
export function mcpToolListFrom(
  tools: ReadonlyArray<ToolDefinition>,
  exposed: ReadonlySet<string>,
): McpToolDefinition[] {
  const out: McpToolDefinition[] = [];
  for (const tool of tools) {
    if (!exposed.has(tool.name)) {
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
 * True if `name` is in the supplied exposure set. Used by the
 * dispatcher to reject `tools/call` for non-allowlisted names
 * (returns `Method not found`-style error).
 */
export function isMcpExposed(name: string, exposed: ReadonlySet<string>): boolean {
  return exposed.has(name);
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
