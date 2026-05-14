import type {
  AddFrontmatterSuggestion,
  ArchiveStaleSuggestion,
  BrokenLinkFixSuggestion,
  StaleReviewSuggestion,
  Suggestion,
} from '../organization/types';

import { BROKEN_LINK_RULE_NAME } from './rules/BrokenLinkRule';
import { MISSING_FRONTMATTER_RULE_NAME } from './rules/MissingFrontmatterRule';
import { ORPHAN_RULE_NAME } from './rules/OrphanRule';
import { STALE_NOTE_RULE_NAME } from './rules/StaleNoteRule';
import type { CuratorFinding } from './types';

/**
 * Phase 7 (v1.0.0) — convert a `CuratorFinding` from the orchestrator
 * into a `Suggestion` ready for the `SuggestionQueue`. Per ADR-022 D4,
 * curator findings reuse the Phase 5 queue + Phase 4 apply paths.
 *
 * Returns `null` for unknown rule names (forward-compat: a future
 * rule version may extend the union; the caller should log + skip).
 *
 * @example
 *   const sug = findingToSuggestion(finding, { now: () => 1700000000000, randomSuffix: () => 'abc123' });
 *   if (sug !== null) await queue.add(sug);
 */
export interface FindingToSuggestionDeps {
  /** Epoch-ms clock. Default `Date.now`. */
  now?: () => number;
  /** Random suffix generator for the `Suggestion.id`. Default uses `Math.random`. */
  randomSuffix?: () => string;
}

export function findingToSuggestion(
  finding: CuratorFinding,
  deps: FindingToSuggestionDeps = {},
): Suggestion | null {
  const now = deps.now ?? (() => Date.now());
  const randomSuffix = deps.randomSuffix ?? defaultRandomSuffix;
  const timestamp = now();
  const id = `${timestamp}-${randomSuffix()}`;

  switch (finding.ruleName) {
    case BROKEN_LINK_RULE_NAME: {
      const payload = finding.payload as
        | { brokenTarget?: unknown; linkText?: unknown }
        | undefined;
      const brokenTarget = typeof payload?.brokenTarget === 'string' ? payload.brokenTarget : null;
      const linkText = typeof payload?.linkText === 'string' ? payload.linkText : null;
      if (brokenTarget === null || linkText === null) {
        return null;
      }
      const suggestion: BrokenLinkFixSuggestion = {
        kind: 'broken-link-fix',
        id,
        createdAt: Math.floor(timestamp / 1000),
        notePath: finding.notePath,
        brokenTarget,
        linkText,
        reason: finding.reason,
        confidence: finding.severity,
      };
      return suggestion;
    }
    case ORPHAN_RULE_NAME: {
      const payload = finding.payload as
        | { archiveFolder?: unknown; staleDays?: unknown }
        | undefined;
      const archiveFolder =
        typeof payload?.archiveFolder === 'string' ? payload.archiveFolder : null;
      const staleDays = typeof payload?.staleDays === 'number' ? payload.staleDays : null;
      if (archiveFolder === null || staleDays === null) {
        return null;
      }
      const suggestion: ArchiveStaleSuggestion = {
        kind: 'archive-stale',
        id,
        createdAt: Math.floor(timestamp / 1000),
        notePath: finding.notePath,
        proposedFolder: archiveFolder,
        staleDays,
        reason: finding.reason,
        confidence: finding.severity,
      };
      return suggestion;
    }
    case MISSING_FRONTMATTER_RULE_NAME: {
      const payload = finding.payload as
        | { schemaPrefix?: unknown; missingFields?: unknown }
        | undefined;
      const schemaPrefix =
        typeof payload?.schemaPrefix === 'string' ? payload.schemaPrefix : null;
      const missingFields =
        Array.isArray(payload?.missingFields) &&
        payload.missingFields.every((f): f is string => typeof f === 'string')
          ? payload.missingFields
          : null;
      if (schemaPrefix === null || missingFields === null || missingFields.length === 0) {
        return null;
      }
      const suggestion: AddFrontmatterSuggestion = {
        kind: 'add-frontmatter',
        id,
        createdAt: Math.floor(timestamp / 1000),
        notePath: finding.notePath,
        schemaPrefix,
        missingFields,
        reason: finding.reason,
        confidence: finding.severity,
      };
      return suggestion;
    }
    case STALE_NOTE_RULE_NAME: {
      const payload = finding.payload as { staleDays?: unknown } | undefined;
      const staleDays = typeof payload?.staleDays === 'number' ? payload.staleDays : null;
      if (staleDays === null) {
        return null;
      }
      const suggestion: StaleReviewSuggestion = {
        kind: 'stale-review',
        id,
        createdAt: Math.floor(timestamp / 1000),
        notePath: finding.notePath,
        staleDays,
        reason: finding.reason,
        confidence: finding.severity,
      };
      return suggestion;
    }
    default:
      return null;
  }
}

function defaultRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
