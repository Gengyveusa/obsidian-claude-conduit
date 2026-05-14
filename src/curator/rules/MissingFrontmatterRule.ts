import type { CuratorRule } from '../CuratorRule';
import type { CuratorFinding } from '../types';

/**
 * Phase 7 (v1.0.1) — missing-required-frontmatter detector per
 * ADR-022 D1.
 *
 * Per-folder schema config: `{folderPrefix: [requiredFields...]}`. A
 * note in a folder matching one of the prefixes must have all listed
 * frontmatter keys; missing any of them produces a finding. The rule
 * deliberately doesn't inspect VALUES — just presence — to keep the
 * detection pure.
 *
 * Severity is medium (0.55) — lower than broken links because some
 * folder schemas may not yet be defined; users should be able to dial
 * threshold lower in PR 4+ if they trust their schemas enough.
 *
 * @example
 *   const rule = makeMissingFrontmatterRule({
 *     '22-Decisions/': ['status', 'date'],
 *     '70-Memory/conversations/': ['session_id'],
 *   });
 */
export const MISSING_FRONTMATTER_RULE_NAME = 'missing-frontmatter';

export interface MissingFrontmatterRuleOptions {
  /**
   * Map from folder prefix (no leading slash; trailing slash optional)
   * to a list of required frontmatter keys. Order matters for prefix
   * matching: the most-specific (longest) matching prefix wins.
   */
  schemas: Record<string, string[]>;
}

export function makeMissingFrontmatterRule(
  opts: MissingFrontmatterRuleOptions,
): CuratorRule {
  // Pre-normalize: strip trailing slashes, sort by length desc so
  // longest prefix wins on match.
  const entries = Object.entries(opts.schemas)
    .map(([prefix, fields]) => [stripTrailingSlash(prefix), fields] as const)
    .sort((a, b) => b[0].length - a[0].length);

  return {
    name: MISSING_FRONTMATTER_RULE_NAME,
    detect: async (corpus) => {
      if (entries.length === 0) {
        return [];
      }
      const findings: CuratorFinding[] = [];
      for (const notePath of await corpus.listAllMarkdown()) {
        const match = matchSchema(notePath, entries);
        if (match === null) {
          continue;
        }
        const required = match.fields;
        let content: string;
        try {
          content = await corpus.read(notePath);
        } catch {
          continue;
        }
        const present = extractFrontmatterKeys(content);
        const missing = required.filter((f) => !present.has(f));
        if (missing.length === 0) {
          continue;
        }
        findings.push({
          ruleName: MISSING_FRONTMATTER_RULE_NAME,
          notePath,
          severity: 0.55,
          reason: `Missing required frontmatter ${missing.map((f) => `\`${f}\``).join(', ')}`,
          payload: {
            schemaPrefix: match.prefix,
            missingFields: missing,
            requiredFields: required,
          },
        });
      }
      return findings;
    },
  };
}

/**
 * Pick the most-specific schema for `notePath`. Returns null when no
 * configured prefix matches. Exported for tests.
 */
export function matchSchema(
  notePath: string,
  entries: ReadonlyArray<readonly [string, string[]]>,
): { prefix: string; fields: string[] } | null {
  for (const [prefix, fields] of entries) {
    if (prefix === '' || notePath.startsWith(`${prefix}/`)) {
      return { prefix, fields };
    }
  }
  return null;
}

/**
 * Parse YAML frontmatter from a markdown note and return the set of
 * top-level keys. Empty set when no frontmatter present. Doesn't
 * validate types — only presence — which is what the rule needs.
 *
 * Exported for tests.
 */
export function extractFrontmatterKeys(content: string): Set<string> {
  const keys = new Set<string>();
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return keys;
  }
  const afterStart = content.indexOf('\n') + 1;
  const closeIdx = content.indexOf('\n---', afterStart);
  if (closeIdx === -1) {
    return keys;
  }
  const block = content.slice(afterStart, closeIdx);
  // Keys are lines matching `key:` at column 0. Nested keys (indented)
  // belong to the parent's value, not the top-level schema.
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (match !== null) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
