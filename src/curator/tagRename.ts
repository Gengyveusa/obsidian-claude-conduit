import type { PatchOp } from '../writes/types';

/**
 * Phase 7 v1.0.6 — tag-normalize apply-path helpers per ADR-024
 * follow-up.
 *
 * The `normalize-tag` suggestion identifies a cluster of tags
 * (`['project', 'projects', 'proj']`) and a canonical pick (`'project'`).
 * To apply, every note that uses any **non-canonical** member needs
 * those occurrences rewritten to the canonical form — across both
 * inline `#tag` references and YAML frontmatter (`tags: [...]`, scalar,
 * block-list).
 *
 * `buildTagRenameOps` is the pure half: take one note's content + the
 * set of non-canonical members + the canonical, return the list of
 * `PatchOp`s that rewrite every affected line. Empty array iff the
 * note uses no member of the cluster.
 *
 * Detection rules — line-by-line, frontmatter-aware:
 *   - Lines inside the YAML frontmatter block (between leading `---`
 *     markers) → rewrite tag-list entries (`tags: [a, b]`, `tags: foo`,
 *     `- foo`).
 *   - Body lines → rewrite inline `#tag` occurrences with strict
 *     boundary (no partial-word match — `#projects/sub` matches the
 *     `projects` root only, becomes `#project/sub`).
 *
 * The replacement preserves the original line structure as much as
 * possible (whitespace, list bullets, quoting) — we substitute the
 * matched substring only.
 */

/** Build the patch ops that rename every non-canonical tag → canonical in `content`. */
export function buildTagRenameOps(
  content: string,
  fromTags: ReadonlySet<string>,
  canonical: string,
): PatchOp[] {
  if (fromTags.size === 0) {
    return [];
  }
  const lines = content.split('\n');
  const inFrontmatterLines = computeFrontmatterRange(lines);
  const ops: PatchOp[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    const rewritten = inFrontmatterLines.has(i)
      ? rewriteFrontmatterLine(original, fromTags, canonical)
      : rewriteBodyLine(original, fromTags, canonical);
    if (rewritten !== null && rewritten !== original) {
      ops.push({
        kind: 'replace',
        startLine: i + 1,
        endLine: i + 1,
        content: rewritten,
      });
    }
  }
  return ops;
}

/** Set of zero-based line indices that fall inside the YAML frontmatter block, if any. */
export function computeFrontmatterRange(lines: string[]): Set<number> {
  const set = new Set<number>();
  if (lines.length < 2 || lines[0].trim() !== '---') {
    return set;
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      // Frontmatter body lines are indices 1..i-1 (exclusive of both `---`).
      for (let j = 1; j < i; j += 1) {
        set.add(j);
      }
      return set;
    }
  }
  return set;
}

/**
 * Rewrite a single body line by substituting non-canonical inline tag
 * occurrences. Returns the new line (possibly equal to the input — the
 * caller checks). Pure / exported for tests.
 */
export function rewriteBodyLine(
  line: string,
  fromTags: ReadonlySet<string>,
  canonical: string,
): string {
  // Heading lines (`# foo`) — these aren't tags, leave them alone.
  if (/^#+\s/.test(line)) {
    return line;
  }
  // Match `#<tag>` at start-of-line or after a non-tag-character.
  // Tag char class matches the rule's extractTags: `[A-Za-z0-9_\-/]+`.
  // Boundary on the right is "not a tag char" so we don't split nested
  // tags incorrectly.
  return line.replace(
    /(^|[^A-Za-z0-9_\-/#])#([A-Za-z][A-Za-z0-9_\-/]*)/g,
    (match, prefix: string, raw: string) => {
      const slashIdx = raw.indexOf('/');
      const root = (slashIdx === -1 ? raw : raw.slice(0, slashIdx)).toLowerCase();
      if (!fromTags.has(root)) {
        return match;
      }
      const suffix = slashIdx === -1 ? '' : raw.slice(slashIdx);
      return `${prefix}#${canonical}${suffix}`;
    },
  );
}

/**
 * Rewrite a single frontmatter line. Handles three shapes:
 *   - inline array `tags: [a, b, c]`
 *   - scalar `tags: foo`
 *   - list item `  - foo`
 * Other lines pass through unchanged.
 */
export function rewriteFrontmatterLine(
  line: string,
  fromTags: ReadonlySet<string>,
  canonical: string,
): string {
  // tags: [a, b]
  const inline = /^(\s*tags\s*:\s*\[)([^\]]*)(\].*)$/.exec(line);
  if (inline !== null) {
    const items = inline[2].split(',').map((part) => {
      const trimmed = part.trim();
      const stripped = trimmed.replace(/^['"]|['"]$/g, '');
      if (fromTags.has(stripped.toLowerCase())) {
        const lead = part.match(/^\s*/)?.[0] ?? '';
        const tail = part.match(/\s*$/)?.[0] ?? '';
        // Preserve quoting style.
        if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
          const q = trimmed[0];
          return `${lead}${q}${canonical}${q}${tail}`;
        }
        return `${lead}${canonical}${tail}`;
      }
      return part;
    });
    return `${inline[1]}${items.join(',')}${inline[3]}`;
  }

  // tags: foo  (scalar; value isn't a `[` or a `-`)
  const scalar = /^(\s*tags\s*:\s*)(['"]?)([^'"\s[-][^'"\s]*)(\2)(\s*(?:#.*)?)$/.exec(line);
  if (scalar !== null) {
    const value = scalar[3];
    if (fromTags.has(value.toLowerCase())) {
      return `${scalar[1]}${scalar[2]}${canonical}${scalar[4]}${scalar[5]}`;
    }
    return line;
  }

  // - foo  (list item under a `tags:` block; we accept any indented `- value`
  //   in frontmatter — caller's job to know it's the tags block, which we
  //   approximate by being in the frontmatter range. False positives on
  //   non-tag lists would be filtered by the membership check anyway.)
  const listItem = /^(\s*-\s*)(['"]?)([^'"\s][^'"\s]*?)(\2)(\s*(?:#.*)?)$/.exec(line);
  if (listItem !== null) {
    const value = listItem[3];
    if (fromTags.has(value.toLowerCase())) {
      return `${listItem[1]}${listItem[2]}${canonical}${listItem[4]}${listItem[5]}`;
    }
  }
  return line;
}
