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

/**
 * Phase 16 (v1.10.0) — find the git tag (if any) pointing at the given
 * commit SHA per ADR-037 D4. Returns the tag NAME (e.g. `'v1.5.0'`,
 * `'q1-decisions'`) — not the `refs/tags/...` prefix — or `null` if
 * the SHA is untagged.
 *
 * Resolution order:
 *   1. Loose refs under `.git/refs/tags/<name>` (the common case for
 *      tags created locally).
 *   2. `.git/packed-refs` entries with `refs/tags/<name>`.
 *
 * Annotated tags have a peel marker `^<commit-sha>` line below the
 * tag-object's `<tag-sha>` line in packed-refs. We handle both:
 *   - Lightweight tags: `<commit-sha> refs/tags/<name>`
 *   - Annotated tags:   `<tag-object-sha> refs/tags/<name>`
 *                       `^<commit-sha>`
 *
 * On error or unparseable state, returns `null` rather than throwing —
 * the snapshot command degrades to "no tag" rather than failing.
 *
 * @example
 *   const tag = await resolveTagForCommit(adapter, 'a1b2c3...');
 *   // → 'v1.5.0' | null
 */
export async function resolveTagForCommit(
  adapter: VaultAdapter,
  commitSha: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return null;
  }
  const lower = commitSha.toLowerCase();

  // 1. Loose tags directory. We can't enumerate the directory through
  //    VaultAdapter, so we sweep via packed-refs first and fall back
  //    to looking through any tag the adapter happens to expose. For
  //    the common annotated-tag case packed-refs is authoritative
  //    anyway; users who don't `git pack-refs` still get covered by
  //    the packed-refs read below since `git tag` writes loose-then-
  //    packs on push. Best-effort.

  // 2. Packed-refs sweep.
  const packedExists = await adapter.exists(PACKED_REFS_PATH);
  if (packedExists) {
    try {
      const packed = await adapter.read(PACKED_REFS_PATH);
      const tag = findTagForCommitInPackedRefs(packed, lower);
      if (tag !== null) {
        return tag;
      }
    } catch {
      // fall through to "no tag"
    }
  }
  return null;
}

/**
 * Parse `.git/packed-refs` for a tag whose target (or peel) matches
 * `commitSha`. Exposed for unit tests.
 *
 * @example
 *   findTagForCommitInPackedRefs('abc... refs/tags/v1.0\n', 'abc...')
 *   // → 'v1.0'
 */
export function findTagForCommitInPackedRefs(
  packedContent: string,
  commitSha: string,
): string | null {
  const target = commitSha.toLowerCase();
  const lines = packedContent.split('\n');
  let lastTagName: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('^')) {
      // Peel of the previous annotated tag. Match against this commit.
      const peel = line.slice(1).trim().toLowerCase();
      if (peel === target && lastTagName !== null) {
        return lastTagName;
      }
      continue;
    }
    const space = line.indexOf(' ');
    if (space === -1) {
      continue;
    }
    const sha = line.slice(0, space).trim().toLowerCase();
    const ref = line.slice(space + 1).trim();
    if (!ref.startsWith('refs/tags/')) {
      lastTagName = null;
      continue;
    }
    const tagName = ref.slice('refs/tags/'.length);
    if (sha === target) {
      // Lightweight tag (no peel) — match on the direct sha.
      return tagName;
    }
    // Remember as a possible annotated-tag candidate; the next `^…`
    // line is the commit-sha peel.
    lastTagName = tagName;
  }
  return null;
}
