import type { VaultAdapter } from '../agent/types';

/**
 * Phase 16 (v2.0) — git history helpers per ADR-037 D1.
 *
 * Sagittarius reads the vault's git history to know what commit
 * HEAD is at, so the time-travel mode can snapshot meaningful
 * points. We deliberately DO NOT execute `git` as a subprocess —
 * that's a Node-only escape hatch that doesn't translate cleanly
 * to Obsidian's sandboxed renderer. Instead we read `.git/`
 * plain files via the existing `VaultAdapter`.
 *
 * Supported git states:
 *   - `.git/HEAD` points at a branch (`ref: refs/heads/main`) — we
 *     resolve the ref to a commit SHA via loose-ref or packed-refs
 *   - `.git/HEAD` contains a bare 40-char SHA (detached HEAD)
 *
 * Pure(-ish): one I/O dep (`VaultAdapter`); no subprocess.
 *
 * When `.git/` is missing or unparseable, returns `null` everywhere.
 * ADR-037 D1 says the time-travel feature gracefully disables — these
 * helpers honor that contract.
 */

const HEAD_PATH = '.git/HEAD';
const PACKED_REFS_PATH = '.git/packed-refs';

/**
 * Read the current HEAD commit SHA. Returns the 40-char hex string
 * on success, `null` when the vault isn't a git repo or HEAD points
 * at a ref we can't resolve.
 *
 * @example
 *   const sha = await readHeadSha(adapter);
 *   if (sha === null) { showNotice('not a git repo'); return; }
 *   // → 'a1b2c3d4e5...'
 */
export async function readHeadSha(adapter: VaultAdapter): Promise<string | null> {
  if (!(await adapter.exists(HEAD_PATH))) {
    return null;
  }
  let headContent: string;
  try {
    headContent = (await adapter.read(HEAD_PATH)).trim();
  } catch {
    return null;
  }
  const refMatch = /^ref:\s+(refs\/.+)$/.exec(headContent);
  if (refMatch !== null) {
    return resolveRef(adapter, refMatch[1]);
  }
  if (/^[0-9a-f]{40}$/i.test(headContent)) {
    return headContent.toLowerCase();
  }
  return null;
}

async function resolveRef(adapter: VaultAdapter, refName: string): Promise<string | null> {
  const loosePath = `.git/${refName}`;
  if (await adapter.exists(loosePath)) {
    try {
      const sha = (await adapter.read(loosePath)).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        return sha.toLowerCase();
      }
    } catch {
      // fall through to packed-refs
    }
  }
  if (!(await adapter.exists(PACKED_REFS_PATH))) {
    return null;
  }
  try {
    const packed = await adapter.read(PACKED_REFS_PATH);
    return resolveRefFromPackedRefs(packed, refName);
  } catch {
    return null;
  }
}

/**
 * Parse `.git/packed-refs` for a given ref. Exposed for tests.
 *
 * Format (per git docs):
 *   # comment
 *   <sha> <refname>
 *   ^<peeled-sha>    -- ignored; tag peel marker
 *
 * @example
 *   resolveRefFromPackedRefs('abc... refs/heads/main\n', 'refs/heads/main')
 *   // → 'abc...'
 */
export function resolveRefFromPackedRefs(
  packedContent: string,
  refName: string,
): string | null {
  for (const line of packedContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('^')) {
      continue;
    }
    const space = trimmed.indexOf(' ');
    if (space === -1) {
      continue;
    }
    const sha = trimmed.slice(0, space).trim();
    const ref = trimmed.slice(space + 1).trim();
    if (ref === refName && /^[0-9a-f]{40}$/i.test(sha)) {
      return sha.toLowerCase();
    }
  }
  return null;
}

/** True iff the vault appears to be a git repository (has `.git/HEAD`). */
export function vaultHasGit(adapter: VaultAdapter): Promise<boolean> {
  return adapter.exists(HEAD_PATH);
}
