import type { AnthropicToolSchema, ToolDefinition } from './types';

/**
 * Phase 16 (v1.10.0) — tool names that mutate vault state. When the
 * ChatView switches to `time-travel` mode the registry's
 * `setWriteBlock()` is set with a reason; any execute() for a name in
 * this set throws the reason as an actionable error per ADR-037 D7.
 *
 * Enumerated here (rather than tagged on each ToolDefinition) so the
 * set is the single canonical answer to "what counts as a write?"
 * The MCP write-side scope mapper (ADR-032) and this gate stay
 * aligned by referring to the same names.
 *
 * `file_asset` writes binary content; `link_notes` only mutates if it
 * adds links (which it does, via patch). Both block.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'create_note',
  'append_to_note',
  'patch_note',
  'rewrite_section',
  'add_frontmatter',
  'move_note',
  'rename_note',
  'delete_note',
  'link_notes',
  'file_asset',
]);

/**
 * Owns the v0.1 tool surface. Each tool registered with `register()` is
 * exposed via `schemas()` for the Anthropic SDK and dispatched via
 * `execute(name, input)` with runtime Zod validation at the boundary.
 *
 * Failure modes (all actionable per spec §8):
 *   - register() with a duplicate name → throws.
 *   - execute() of an unknown name → throws (the agent loop catches
 *     and surfaces as is_error tool_result).
 *   - execute() with input that fails Zod → throws with the Zod issue
 *     paths concatenated for diagnosability.
 *   - execute() of a write tool while `setWriteBlock` is set → throws
 *     with the supplied reason (Phase 16 / ADR-037 D7).
 *
 * @example
 *   const reg = new ToolRegistry();
 *   reg.register(makeReadNoteTool(vaultAdapter));
 *   const res = await reg.execute('read_note', { path: 'a.md' });
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private writeBlockReason: string | null = null;

  /**
   * Register a tool. Throws on duplicate name to catch wiring mistakes early.
   * @example reg.register(makeReadNoteTool(adapter));
   */
  register<I, O>(tool: ToolDefinition<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `ToolRegistry.register: tool '${tool.name}' is already registered. ` +
          `Each tool name must be unique within a registry.`,
      );
    }
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  /** True if a tool with this name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Names of every registered tool, in registration order. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Full `ToolDefinition[]` in registration order. Used by the MCP
   * adapter (Phase 6.5 PR 3) to expose tools to external clients,
   * and by any future code that wants to inspect the registry shape.
   */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Emit Anthropic-compatible tool definitions for the SDK's `tools` field.
   * @example client.messages.create({ tools: reg.schemas(), ... })
   */
  schemas(): AnthropicToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema as AnthropicToolSchema['input_schema'],
    }));
  }

  /**
   * Phase 16 (v1.10.0) — set or clear the write-block. When set to a
   * non-null reason, every subsequent `execute()` of a write tool
   * (names in `WRITE_TOOL_NAMES`) throws with the supplied reason.
   * The agent surfaces the throw as an `is_error` tool_result, which
   * lets the model see + react to the constraint without the operator
   * having to accidentally accept a proposal.
   *
   * Reads pass through unchanged. Per ADR-037 D7, enforcement happens
   * at the registry rather than the prompt so a confused agent can't
   * round-trip the write into the diff card.
   *
   * @example reg.setWriteBlock("Time-travel mode is read-only — you can't edit the past.");
   * @example reg.setWriteBlock(null); // clear
   */
  setWriteBlock(reason: string | null): void {
    this.writeBlockReason = reason;
  }

  /** Read the current write-block reason (or null if writes are allowed). */
  getWriteBlock(): string | null {
    return this.writeBlockReason;
  }

  /**
   * Dispatch a tool call. Validates input with the tool's Zod schema first
   * so handlers can rely on shape; surfaces validation failures as a single
   * actionable Error string.
   * @example const result = await reg.execute('read_note', { path: 'a.md' });
   */
  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(
        `ToolRegistry.execute: no tool named '${name}' is registered. ` +
          `Available tools: ${this.names().join(', ') || '(none)'}.`,
      );
    }
    if (this.writeBlockReason !== null && WRITE_TOOL_NAMES.has(name)) {
      throw new Error(this.writeBlockReason);
    }
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(
        `ToolRegistry.execute: input validation failed for '${name}'. ${issues}`,
      );
    }
    return tool.handler(parsed.data);
  }
}
