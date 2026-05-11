/**
 * Pure helpers for `rewrite_section`. A "section" is the block of body
 * lines between one heading and the next heading of equal-or-lesser depth
 * (or EOF). The heading itself is preserved; only the body is replaced.
 *
 * Heading match is exact: trimmed text and the same #-prefix depth as
 * `targetHeader`. If multiple headings match, the first is rewritten —
 * the LLM should pick a more specific header if that's wrong.
 *
 * @example
 *   const after = rewriteSection(
 *     '# A\nfoo\n## B\nbar\n## C\nbaz',
 *     '## B',
 *     'BAR'
 *   );
 *   // → '# A\nfoo\n## B\nBAR\n## C\nbaz'
 */

export interface SectionRange {
  /** 0-indexed line of the matched heading. */
  headingIdx: number;
  /** 0-indexed first line of the section body (just after the heading). */
  bodyStart: number;
  /**
   * 0-indexed line one past the section body end (exclusive). Useful for
   * `lines.splice(bodyStart, bodyEnd - bodyStart, ...newLines)`.
   */
  bodyEnd: number;
  /** Heading depth (number of '#' chars). 1..6. */
  depth: number;
}

/**
 * Find the first section whose heading line matches `targetHeader` exactly
 * (after trimming). Returns null if no match.
 *
 * `targetHeader` must include the `#` prefix(es) — e.g. `"## Setup"`.
 */
export function findSection(content: string, targetHeader: string): SectionRange | null {
  const target = targetHeader.trim();
  const targetDepth = headingDepth(target);
  if (targetDepth === 0) {
    return null;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target) {
      // Found the heading. Now find the section body's end.
      let bodyEnd = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const d = headingDepth(lines[j].trim());
        if (d > 0 && d <= targetDepth) {
          bodyEnd = j;
          break;
        }
      }
      return {
        headingIdx: i,
        bodyStart: i + 1,
        bodyEnd,
        depth: targetDepth,
      };
    }
  }
  return null;
}

/**
 * Replace the body of the section with `targetHeader` with `newBody`.
 * The heading itself stays. Returns the new content. Throws if no
 * matching heading is found.
 *
 * `newBody` is inserted verbatim; the caller is responsible for any
 * trailing newline. We don't auto-normalize because that would conflict
 * with how `add_frontmatter` and `patch_note` already handle whitespace.
 */
export function rewriteSection(
  content: string,
  targetHeader: string,
  newBody: string,
): string {
  const range = findSection(content, targetHeader);
  if (range === null) {
    throw new Error(
      `rewriteSection: no heading "${targetHeader.trim()}" found. ` +
        'Pass the exact heading text including # prefix (e.g. "## Setup").',
    );
  }
  const lines = content.split('\n');
  const newBodyLines = newBody.split('\n');
  lines.splice(range.bodyStart, range.bodyEnd - range.bodyStart, ...newBodyLines);
  return lines.join('\n');
}

/**
 * 0 if `line` is not a heading. Otherwise the depth (1..6) based on the
 * number of leading `#` chars. ATX-style only — Setext underlines aren't
 * recognized for v0.3.x.
 */
function headingDepth(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match === null ? 0 : match[1].length;
}
