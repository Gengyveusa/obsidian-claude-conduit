import type { VaultAdapter } from '../agent/types';

/**
 * Snapshot of a file's identity at one moment in time. Captured at read,
 * verified at write to detect concurrent edits per ADR-016 D4 (optimistic
 * concurrency with mtime + SHA-256).
 *
 * Why both fields:
 *   - `mtime` is a fast-path: if it hasn't changed, the file is unchanged.
 *     But mtime can drift without content change (e.g. `touch foo.md`),
 *     which would false-flag.
 *   - `hashHex` is authoritative. When mtime differs we re-hash to confirm
 *     whether the content actually changed.
 */
export interface FileSnapshot {
  /** Epoch seconds. Matches `VaultAdapter.stat().mtime`. */
  mtime: number;
  /** Lowercase hex SHA-256 of the file's UTF-8-encoded content. */
  hashHex: string;
}

/**
 * Thrown when a write tool's apply step detects that the target file
 * changed between read time and write time. The agent should surface
 * this to the LLM (or user) so the proposal can be regenerated against
 * the new state.
 */
export class WriteConflictError extends Error {
  constructor(
    public readonly path: string,
    public readonly before: FileSnapshot,
    public readonly afterHashHex: string,
  ) {
    super(
      `Write conflict on ${path}: file was modified between read and write. ` +
        `Expected hash ${before.hashHex.slice(0, 12)}…, found ${afterHashHex.slice(0, 12)}…. ` +
        'Likely cause: user edited the file in Obsidian while the agent was proposing. ' +
        'Re-read the file and re-propose the patch.',
    );
    this.name = 'WriteConflictError';
  }
}

/**
 * Helpers for ADR-016 D4 / P2 — write-conflict detection. Pure functions
 * over a `VaultAdapter`; no global state. Tools call:
 *
 *   1. `snapshot(adapter, path)` at the moment they read the file body.
 *   2. `verifyUnchanged(adapter, path, snapshot)` immediately before the
 *      apply step writes the new content. Throws `WriteConflictError`
 *      if the file's current hash doesn't match the snapshot.
 *
 * The reason we expose helpers (not a class with state) is that the
 * snapshot lives on the `Proposal` itself — captured by the closure that
 * built the proposal — and gets verified inside `proposal.apply()`.
 * Stateless helpers compose cleanly with that pattern.
 *
 * @example
 *   const content = await adapter.read(path);
 *   const before = await snapshot(adapter, path);   // captures mtime + hash
 *   // ... build a Proposal whose apply() calls verifyUnchanged before write
 */

/** Capture a snapshot of `path`. Throws if the file doesn't exist. */
export async function snapshot(
  adapter: VaultAdapter,
  path: string,
): Promise<FileSnapshot> {
  const stat = await adapter.stat(path);
  if (stat === null) {
    throw new Error(
      `ConflictDetector.snapshot: ${path} does not exist. ` +
        "Snapshot is only meaningful for files the tool just read.",
    );
  }
  const content = await adapter.read(path);
  const hashHex = await sha256Hex(content);
  return { mtime: stat.mtime, hashHex };
}

/**
 * Verify that `path` is still in the state recorded in `before`. Throws
 * `WriteConflictError` if not. Returns silently if the file matches.
 *
 * Implementation: if `mtime` matches, the file is unchanged (fast path,
 * skipping the hash). If mtime differs, re-hash to confirm whether the
 * content actually changed (mtime can drift on `touch` without a real edit).
 */
export async function verifyUnchanged(
  adapter: VaultAdapter,
  path: string,
  before: FileSnapshot,
): Promise<void> {
  const stat = await adapter.stat(path);
  if (stat === null) {
    throw new WriteConflictError(path, before, '<file deleted>');
  }
  // Fast path: mtime unchanged → assume content unchanged.
  if (stat.mtime === before.mtime) {
    return;
  }
  // Slow path: mtime drifted; re-hash to confirm.
  const current = await adapter.read(path);
  const currentHash = await sha256Hex(current);
  if (currentHash !== before.hashHex) {
    throw new WriteConflictError(path, before, currentHash);
  }
}

/**
 * Hex SHA-256 of `text` (UTF-8). Uses Web Crypto, which is available in
 * Electron's renderer and Node 18+ (the two environments we ship and test
 * in). Returns 64 lowercase hex chars.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}
