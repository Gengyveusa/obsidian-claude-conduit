/**
 * Phase 8 (v1.1.1) — draft path conventions per ADR-026 D1 (b) + D7.
 *
 * Drafts live at `_drafts/<destinationFolder>/<slug>.md`. Promotion is
 * `move_note` from the draft path to the same path with `_drafts/`
 * stripped — the destination folder structure mirrors where the
 * canonical note will end up.
 *
 * Pure functions, no I/O. Tested in isolation.
 */

/** Folder prefix all drafts live under per ADR-026 D1 (b). */
export const DRAFTS_ROOT = '_drafts/';

/**
 * Slug a free-text topic into a filename-safe segment. Lowercases,
 * replaces runs of non-alphanumeric chars with single dashes, trims
 * leading/trailing dashes, caps to `maxLen` chars (default 64).
 *
 * @example
 *   slugifyTopic('Q3 roadmap synthesis from leadership-sync notes')
 *   // → 'q3-roadmap-synthesis-from-leadership-sync-notes'
 */
export function slugifyTopic(topic: string, maxLen = 64): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    return 'untitled';
  }
  if (slug.length <= maxLen) {
    return slug;
  }
  const truncated = slug.slice(0, maxLen);
  // Avoid ending on a dash after truncation.
  return truncated.replace(/-+$/, '');
}

/**
 * Build the full vault-relative draft path from a destination folder
 * + topic. Normalizes folder separators (strips leading slash, ensures
 * trailing slash) so callers can pass `'30-Projects'`, `'30-Projects/'`,
 * or `'/30-Projects/'` uniformly.
 *
 * @example
 *   draftPathFor('30-Projects', 'Q3 synthesis')
 *   // → '_drafts/30-Projects/q3-synthesis.md'
 */
export function draftPathFor(destinationFolder: string, topic: string): string {
  const folder = normalizeFolder(destinationFolder);
  const slug = slugifyTopic(topic);
  return `${DRAFTS_ROOT}${folder}${slug}.md`;
}

/**
 * Inverse of `draftPathFor` for the promotion path per ADR-026 D7 (a).
 * Strips the `_drafts/` prefix; the rest is the canonical path.
 * Throws if `path` isn't under `DRAFTS_ROOT` — promotion is meaningful
 * only for drafts.
 *
 * @example
 *   promotedPathFor('_drafts/30-Projects/q3.md')
 *   // → '30-Projects/q3.md'
 */
export function promotedPathFor(draftPath: string): string {
  if (!isDraftPath(draftPath)) {
    throw new Error(
      `promotedPathFor: '${draftPath}' is not a draft path. ` +
        `Drafts live under '${DRAFTS_ROOT}'.`,
    );
  }
  return draftPath.slice(DRAFTS_ROOT.length);
}

/** True if `path` is under the `_drafts/` quarantine. */
export function isDraftPath(path: string): boolean {
  return path.startsWith(DRAFTS_ROOT);
}

/**
 * Append a numeric suffix to avoid collisions when a draft with the
 * same slug already exists (`q3-synthesis.md` → `q3-synthesis-2.md`).
 * Caller checks existence via the vault adapter and re-invokes with
 * `attempt + 1` if needed.
 *
 * @example
 *   draftPathWithSuffix('_drafts/x/q3.md', 2)
 *   // → '_drafts/x/q3-2.md'
 */
export function draftPathWithSuffix(basePath: string, attempt: number): string {
  if (attempt < 2) {
    return basePath;
  }
  const dot = basePath.lastIndexOf('.');
  if (dot < 0) {
    return `${basePath}-${attempt}`;
  }
  return `${basePath.slice(0, dot)}-${attempt}${basePath.slice(dot)}`;
}

function normalizeFolder(folder: string): string {
  let f = folder.trim();
  if (f.startsWith('/')) {
    f = f.slice(1);
  }
  if (f.length === 0) {
    return '';
  }
  if (!f.endsWith('/')) {
    f = `${f}/`;
  }
  return f;
}
