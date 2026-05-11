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
  /** Read a file as raw bytes — used for sqlite index persistence. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /**
   * Write (or overwrite) a UTF-8 text file at the given vault-relative path.
   *
   * The implementation MUST ensure the parent directory exists (v0.2.6
   * contract per ADR-015). Production `VaultAdapterImpl.write()` derives
   * the parent dir and calls `mkdir` defensively before delegating.
   * Phase 4 write tools rely on this so they don't have to remember the
   * mkdir dance for each new write target.
   */
  write(path: string, content: string): Promise<void>;
  /**
   * Write (or overwrite) raw bytes — used for sqlite index persistence.
   * Same parent-dir auto-create contract as `write()`.
   */
  writeBinary(path: string, content: ArrayBuffer): Promise<void>;
  /**
   * Create the folder if it doesn't exist. No-op if it does. Per ADR-015,
   * Obsidian's `DataAdapter.mkdir` is recursive — calling `mkdir('a/b/c')`
   * creates all intermediate dirs in one call.
   */
  mkdir(path: string): Promise<void>;
  /**
   * Delete the file at `path`. Throws if the file doesn't exist (callers
   * who want a no-op-on-missing semantic should `exists()` first).
   *
   * Added v0.4.0 for the `undo_last_transaction` command — it needs to
   * reverse `create_note` proposals by deleting the file. Production
   * wraps Obsidian's `DataAdapter.remove()`.
   */
  delete(path: string): Promise<void>;
  stat(path: string): Promise<VaultStat | null>;
  list(folderPath: string): Promise<{ files: string[]; folders: string[] }>;
  /**
   * Return every `.md` file in the vault as a flat list of vault-relative
   * paths. Production wraps `app.vault.getMarkdownFiles()` per ADR-015's
   * audit; tests can derive from a map. Used by the Indexer instead of
   * recursing through `list()`.
   *
   * Note (ADR-015 correction): we originally adopted this in v0.2.3
   * because we believed `list('')` was throwing in production. A live
   * audit later disproved that hypothesis — both `list('')` and `list('/')`
   * actually work fine. The true root cause of the v0.2.0-v0.2.2 walker
   * failure was never proven. `getMarkdownFiles()` is still the right
   * choice on architectural merit (canonical Obsidian API, no recursion,
   * no edge cases).
   */
  listAllMarkdown(): Promise<string[]>;
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
