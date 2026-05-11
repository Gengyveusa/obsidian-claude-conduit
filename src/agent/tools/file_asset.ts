import { z } from 'zod';

import { assertInVault, VaultPathTraversalError } from '../validation';
import type { ApprovalGate } from '../../writes/ApprovalGate';
import type { Proposal } from '../../writes/types';
import type { WriteToolContext } from '../../writes/WriteToolContext';
import type { ToolDefinition, VaultAdapter } from '../types';

const inputSchema = z.object({
  filename: z
    .string()
    .min(1, 'filename must be non-empty')
    .refine((s) => !s.includes('/'), "filename must not contain '/' — use `folder` instead")
    .refine((s) => !s.startsWith('.'), "filename must not start with '.'"),
  base64Content: z
    .string()
    .min(1, 'base64Content must be non-empty')
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64Content must be valid base64 (no whitespace, no data URL prefix)'),
  folder: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface FileAssetResult {
  status: 'applied' | 'rejected' | 'error';
  path: string;
  reason?: string;
  error?: string;
  sizeBytes?: number;
}

export interface FileAssetDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  /** Default folder when the LLM doesn't pass one. From settings. */
  defaultFolder: string;
  now?: () => number;
}

/**
 * v0.5.0 `file_asset` tool — write a binary attachment (image, PDF, etc.)
 * into the vault. Last of the 9 write tools in ADR-016 D6's surface.
 *
 * Input separates `filename` (bare name, no slashes) from `folder`
 * (optional vault-relative dir; falls back to `defaultFolder`). The
 * tool computes the full target path, refuses if it escapes the vault
 * or already exists, decodes the base64 input to bytes, and routes a
 * binary-file proposal through the approval gate.
 *
 * Inverse op: `delete-file` (same as `create_note`).
 *
 * @example
 *   // The LLM calls this after, say, generating a diagram. base64Content
 *   // is the PNG bytes, base64-encoded.
 *   handler({ filename: 'arch.png', base64Content: '...' });
 */
export function makeFileAssetTool(deps: FileAssetDeps): ToolDefinition<Input, FileAssetResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    name: 'file_asset',
    description:
      "Propose writing a binary file (image, PDF, etc) into the vault. " +
      'Provide `filename` (bare, no slashes), `base64Content` (raw base64, no data URL prefix), ' +
      'and optionally `folder` (vault-relative dir; defaults to the configured attachments folder). ' +
      "Refuses if the target path exists or escapes the vault. " +
      "Returns { status: 'applied' | 'rejected' | 'error', path, sizeBytes?, reason?, error? }.",
    inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Bare filename including extension, e.g. `architecture.png`.',
        },
        base64Content: {
          type: 'string',
          description:
            'Raw base64 of the file bytes. No `data:` prefix, no newlines or whitespace inside.',
        },
        folder: {
          type: 'string',
          description:
            'Optional vault-relative folder. Defaults to the configured attachments folder (typically `attachments`).',
        },
      },
      required: ['filename', 'base64Content'],
    },
    handler: async ({ filename, base64Content, folder }) => {
      const targetFolder = folder !== undefined && folder.length > 0 ? folder : deps.defaultFolder;
      const targetPath =
        targetFolder.length > 0 ? `${stripTrailingSlash(targetFolder)}/${filename}` : filename;

      try {
        assertInVault(targetPath);
      } catch (err) {
        if (err instanceof VaultPathTraversalError) {
          return { status: 'error', path: targetPath, error: err.message };
        }
        throw err;
      }

      if (await deps.adapter.exists(targetPath)) {
        return {
          status: 'error',
          path: targetPath,
          error: `Asset already exists: ${targetPath}. Pick a different filename or folder.`,
        };
      }

      let bytes: ArrayBuffer;
      try {
        bytes = base64ToArrayBuffer(base64Content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'error', path: targetPath, error: `base64 decode failed: ${msg}` };
      }

      const sizeBytes = bytes.byteLength;

      const proposal: Proposal = {
        toolName: 'file_asset',
        args: { filename, base64Content, ...(folder !== undefined && { folder }) },
        diff: { kind: 'binary-file', path: targetPath, sizeBytes },
        apply: async () => {
          await deps.adapter.writeBinary(targetPath, bytes);
          return {
            toolName: 'file_asset',
            path: targetPath,
            appliedAt: now(),
            inverse: { kind: 'delete-file', path: targetPath },
          };
        },
      };

      const decision = await deps.gate.request(proposal);
      if (decision.kind === 'reject') {
        const result: FileAssetResult = { status: 'rejected', path: targetPath };
        if (decision.reason !== undefined) {
          result.reason = decision.reason;
        }
        return result;
      }

      const appliedOp = await proposal.apply();
      deps.ctx.record(appliedOp);
      return { status: 'applied', path: targetPath, sizeBytes };
    },
  };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Decode `b64` (raw base64, no data URL prefix) to an `ArrayBuffer`.
 * Uses the browser `atob` API which is available in Electron's renderer
 * and Node 18+. Throws on malformed input.
 *
 * Exported for tests.
 */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
