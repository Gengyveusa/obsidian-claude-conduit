/**
 * Phase 13 (v1.6.0) — chat-note path conventions per ADR-034 D1.
 *
 * Chat notes live at `_chats/<YYYY-MM-DD>/<slug>.md`. Date subfolder
 * keeps the directory bounded; slug from the first user message
 * keeps each file recognizable. Pure module — no I/O.
 *
 * Mirrors the existing `_drafts/` quarantine pattern: prefix-marked
 * (underscore), operator-visible, organization-engine-ignored.
 */

/** Folder prefix all chat notes live under per ADR-034 D1. */
export const CHATS_ROOT = '_chats/';

/**
 * Slug a free-text label into a filename-safe segment. Same algorithm
 * as `slugifyTopic` from drafts/paths.ts but lives separately so the
 * two domains can evolve independently (chats might want different
 * length caps, language handling, etc.).
 *
 * @example
 *   slugifyChat('What is the Q3 strategy for FortressFlow?')
 *   // → 'what-is-the-q3-strategy-for-fortressflow'
 */
export function slugifyChat(label: string, maxLen = 50): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    return 'untitled';
  }
  if (slug.length <= maxLen) {
    return slug;
  }
  return slug.slice(0, maxLen).replace(/-+$/, '');
}

/**
 * Compute the chat-note path for a given date + slug.
 * Date interpretation matches operator's local timezone.
 *
 * @example
 *   chatNotePathFor(new Date(), 'America/Los_Angeles', 'q3-strategy')
 *   // → '_chats/2026-05-16/q3-strategy.md'
 */
export function chatNotePathFor(now: Date, timezone: string, slug: string): string {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: timezone });
  return `${CHATS_ROOT}${ymd}/${slug}.md`;
}

/** True iff `path` is a chat-note path Sagittarius might have written. */
export function isChatNotePath(path: string): boolean {
  if (!path.startsWith(CHATS_ROOT)) {
    return false;
  }
  const rest = path.slice(CHATS_ROOT.length);
  if (rest.startsWith('_archive/')) {
    return false;
  }
  // Must match YYYY-MM-DD/<slug>.md exactly — guards against
  // accidental nesting/files at other depths.
  return /^\d{4}-\d{2}-\d{2}\/[a-z0-9][a-z0-9_-]*\.md$/.test(rest);
}

/**
 * Append a numeric suffix if a chat note with the same slug already
 * exists for the same day. Mirrors `draftPathWithSuffix` semantics.
 *
 * @example
 *   chatPathWithSuffix('_chats/2026-05-16/q3.md', 2)
 *   // → '_chats/2026-05-16/q3-2.md'
 */
export function chatPathWithSuffix(basePath: string, attempt: number): string {
  if (attempt < 2) {
    return basePath;
  }
  const dot = basePath.lastIndexOf('.');
  if (dot < 0) {
    return `${basePath}-${attempt}`;
  }
  return `${basePath.slice(0, dot)}-${attempt}${basePath.slice(dot)}`;
}
