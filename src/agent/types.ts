import type { z } from 'zod';

/**
 * A tool the agent can call. Owns its name, JSON schema (for the
 * Anthropic SDK), Zod schema (for runtime input validation per spec
 * quality gate "tests with the feature"), and an async handler.
 *
 * Tool-side error handling: handlers either return a result object
 * or throw an Error. ToolRegistry.execute() catches throws and
 * surfaces them as is_error tool_results upstream.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** Runtime validator. Mirrors `jsonSchema` for the agent loop's edges. */
  inputSchema: z.ZodSchema<I>;
  /** Anthropic-compatible JSON schema. Hand-written to avoid a deps bump. */
  jsonSchema: object;
  handler: (input: I) => Promise<O>;
}

/**
 * Anthropic SDK's `tools` field shape. ToolRegistry.schemas() emits this.
 */
export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: object;
}

/**
 * Minimal vault adapter used by the v0.1 read tools. Intentionally a
 * subset of Obsidian's `DataAdapter` so tests can fake it without
 * importing the real Obsidian module. Production wires this to
 * `app.vault.adapter` at plugin onload.
 *
 * @example
 *   const adapter: VaultAdapter = app.vault.adapter;  // production
 *   const adapter: VaultAdapter = new FakeVaultAdapter({...});  // tests
 */
export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  stat(path: string): Promise<VaultStat | null>;
  list(folderPath: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface VaultStat {
  /** POSIX epoch seconds (float), per the embedding contract §3 encoding rules. */
  mtime: number;
  /** File size in bytes. */
  size: number;
}
