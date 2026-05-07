import { z } from 'zod';

import { splitFrontmatter } from '../../util/frontmatter';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  path: z
    .string()
    .min(1, 'path must be non-empty')
    .refine((p) => !p.includes('..'), 'path must not contain ".." segments')
    .refine((p) => !p.startsWith('/'), 'path must be vault-relative (no leading slash)'),
});

type Input = z.infer<typeof inputSchema>;

export interface ReadNoteResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  /** POSIX epoch seconds (float). */
  mtime: number;
  size_bytes: number;
}

/**
 * Construct the `read_note` tool bound to a vault adapter. Returns the
 * frontmatter (parsed YAML) and body of a vault-relative markdown note,
 * or null if the note does not exist or is outside the vault.
 *
 * Threat model (per spec §7): rejects `..` and absolute paths at the Zod
 * boundary so the LLM cannot escape the vault. The adapter itself is
 * vault-scoped; this is defense in depth.
 *
 * @example
 *   const tool = makeReadNoteTool(app.vault.adapter);
 *   reg.register(tool);
 */
export function makeReadNoteTool(
  adapter: VaultAdapter,
): ToolDefinition<Input, ReadNoteResult | null> {
  return {
    name: 'read_note',
    description:
      "Read a vault note's frontmatter and body. " +
      "Returns null if the path doesn't exist or is outside the vault.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            "Vault-relative path with forward slashes, e.g. '50-FortressFlow/Pipeline_State.md'.",
        },
      },
      required: ['path'],
    },
    handler: async ({ path }) => {
      const exists = await adapter.exists(path);
      if (!exists) {
        return null;
      }
      const raw = await adapter.read(path);
      const stat = await adapter.stat(path);
      if (!stat) {
        return null;
      }

      const { frontmatter, body } = splitFrontmatter(raw);
      return {
        path,
        frontmatter,
        body,
        mtime: stat.mtime,
        size_bytes: stat.size,
      };
    },
  };
}

