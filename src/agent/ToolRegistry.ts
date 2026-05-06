import type { AnthropicToolSchema, ToolDefinition } from './types';

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
 *
 * @example
 *   const reg = new ToolRegistry();
 *   reg.register(makeReadNoteTool(vaultAdapter));
 *   const res = await reg.execute('read_note', { path: 'a.md' });
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

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
   * Emit Anthropic-compatible tool definitions for the SDK's `tools` field.
   * @example client.messages.create({ tools: reg.schemas(), ... })
   */
  schemas(): AnthropicToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema,
    }));
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
