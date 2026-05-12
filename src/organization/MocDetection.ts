/**
 * Phase 5 (v0.6.x) MOC detection per [ADR-017](../../docs/2026-05-11-adr-017-phase-5-plan.md) D6.
 *
 * A "Map of Content" (MOC) note in Obsidian is one that lists other notes
 * as a navigation aid. We recognize them by shape, not by filename or
 * frontmatter, so users don't have to tag every MOC explicitly.
 *
 * Detection heuristic (intentionally lenient):
 *   1. The note has at least one heading line (any depth).
 *   2. The note's body has at least 3 bullet items that contain a
 *      `[[wikilink]]` (`- [[X]]`, `* [[X]]`, or `1. [[X]]`).
 *   3. Wikilink-bullet lines are at least 30% of non-blank body lines.
 *
 * Why those thresholds: a regular note with two or three links sprinkled
 * in prose shouldn't false-positive; a true MOC reads as mostly a list.
 * Frontmatter is stripped before measurement.
 *
 * @example
 *   looksLikeMoc('# Decisions\n- [[ADR-001]]\n- [[ADR-002]]\n- [[ADR-003]]')  // true
 *   looksLikeMoc('My weekly notes:\n- [[meeting]] was good')                  // false (no heading)
 */

import { splitFrontmatter } from '../util/frontmatter';

export interface MocShapeMetrics {
  /** True if shape thresholds pass. */
  looksLikeMoc: boolean;
  /** First heading line (without leading #s), or null. */
  firstHeading: string | null;
  /** Count of bullet lines that contain a wikilink. */
  wikilinkBulletCount: number;
  /** Count of non-blank lines in the body. */
  bodyLineCount: number;
  /** wikilinkBulletCount / bodyLineCount, rounded to 2 decimals. */
  linkDensity: number;
}

/** Returns `true` if `content` looks like a MOC per the heuristic. */
export function looksLikeMoc(content: string): boolean {
  return analyzeMocShape(content).looksLikeMoc;
}

/**
 * Full analysis — returns the underlying signals so callers (e.g. the
 * moc-add classifier prompt) can show the LLM what was detected.
 */
export function analyzeMocShape(content: string): MocShapeMetrics {
  const { body } = splitFrontmatter(content);
  const lines = body.split('\n');

  let firstHeading: string | null = null;
  let wikilinkBulletCount = 0;
  let nonBlankLineCount = 0;
  let hasHeading = false;

  const headingPattern = /^#{1,6}\s+(.+?)\s*$/;
  // Matches:
  //   - [[X]]    * [[X]]    1. [[X]]    - [[X|alias]]
  // optionally followed by trailing prose.
  const wikilinkBulletPattern = /^\s*(?:[-*]|\d+\.)\s+.*\[\[[^\]]+]]/;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    nonBlankLineCount++;

    const headingMatch = headingPattern.exec(line);
    if (headingMatch !== null) {
      hasHeading = true;
      if (firstHeading === null) {
        firstHeading = headingMatch[1];
      }
      continue;
    }

    if (wikilinkBulletPattern.test(line)) {
      wikilinkBulletCount++;
    }
  }

  const linkDensity =
    nonBlankLineCount === 0
      ? 0
      : Math.round((wikilinkBulletCount / nonBlankLineCount) * 100) / 100;

  const passes =
    hasHeading &&
    wikilinkBulletCount >= 3 &&
    linkDensity >= 0.3;

  return {
    looksLikeMoc: passes,
    firstHeading,
    wikilinkBulletCount,
    bodyLineCount: nonBlankLineCount,
    linkDensity,
  };
}
