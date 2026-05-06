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
  /**
   * Runtime validator. Mirrors `jsonSchema` for the agent loop's edges.
   * Input is `unknown` so schemas with `.default()` (whose accept
   * `undefined`) typecheck under `exactOptionalPropertyTypes: true`.
   */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** Anthropic-compatible JSON schema. Hand-written to avoid a deps bump. */
  jsonSchema: object;
  handler: (input: I) => Promise<O>;
}

/**
 * Anthropic SDK's `tools` field shape. ToolRegistry.schemas() emits this.
 * `input_schema` is narrowed to the `{ type: 'object', ... }` form that
 * the SDK's Tool type wants.
 */
export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Minimal vault adapter used by the v0.1 read tools + ConversationLogger.
 * Intentionally a subset of Obsidian's `DataAdapter` so tests can fake it
 * without importing the real Obsidian module. Production wires this to
 * `app.vault.adapter` at plugin onload.
 *
 * @example
 *   const adapter: VaultAdapter = app.vault.adapter;  // production
 *   const adapter: VaultAdapter = new FakeVaultAdapter({...});  // tests
 */
export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Write (or overwrite) a UTF-8 text file at the given vault-relative path. */
  write(path: string, content: string): Promise<void>;
  /** Create the folder if it doesn't exist. No-op if it does. */
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<VaultStat | null>;
  list(folderPath: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface VaultStat {
  /** POSIX epoch seconds (float), per the embedding contract §3 encoding rules. */
  mtime: number;
  /** File size in bytes. */
  size: number;
}

/**
 * One wikilink reference inside a note. `link` is the raw target text
 * (may be unresolved); `line` is the 0-indexed line number where the
 * link appears.
 */
export interface FileLinkRef {
  link: string;
  line: number;
}

/**
 * Per-file metadata as exposed by Obsidian's MetadataCache. Subset
 * of what `app.metadataCache.getFileCache(tfile)` returns; tests
 * provide this directly without an Obsidian dependency.
 */
export interface FileMetadata {
  links: FileLinkRef[];
  frontmatter: Record<string, unknown> | null;
}

/**
 * Minimal metadata-cache shim used by the v0.1 backlinks + graph tools.
 * Production wires this to `app.metadataCache` at plugin onload; tests
 * inject a plain object.
 */
export interface MetadataCache {
  /**
   * Outbound resolved wikilinks: resolvedLinks[sourcePath][targetPath]
   * = link count. Mirrors Obsidian's `app.metadataCache.resolvedLinks`.
   */
  resolvedLinks: Record<string, Record<string, number>>;

  /** Per-file metadata; null if the file isn't indexed. */
  getFileMetadata(path: string): FileMetadata | null;

  /** Resolve a wikilink target text to a vault-relative path. */
  resolveLink(linkText: string, sourcePath: string): string | null;
}
