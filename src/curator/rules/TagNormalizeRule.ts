import type { CuratorRule } from '../CuratorRule';
import type { CuratorCorpus, CuratorFinding } from '../types';

/**
 * Phase 7 (v1.0.2) — tag normalization detector per ADR-022 D1
 * (v1.x LLM-judged row).
 *
 * Two-stage hybrid:
 *
 *   1. **Pre-filter (cheap):** enumerate every tag used across the
 *      vault, cluster tags that look like the same concept under
 *      `#project` / `#projects` / `#Project` (case-insensitive +
 *      Levenshtein distance ≤ `maxEditDistance`). Single-tag clusters
 *      (i.e., the tag has no near-neighbors) drop out.
 *   2. **LLM confirm (expensive):** for each multi-tag cluster, ask
 *      the judge whether they're the same concept and, if so, which
 *      should be canonical. Budget-capped at `maxLlmCalls` per sweep
 *      per ADR-022 D6.
 *
 * Output: one `CuratorFinding` per confirmed cluster — payload
 * carries `cluster` (tags in the cluster, lowercase), `canonical`
 * (LLM's pick), and the count of notes using non-canonical members.
 *
 * Severity = 0.4 + clusterSize × 0.05 (cap 0.65). Lower than
 * broken-link findings (0.9) because tag normalization is
 * judgment-heavy — false positives waste user attention.
 *
 * **Apply path** is text-rewrite via `patch_note` × N (Phase 7 v1.0.2
 * ships the detection; the apply path uses N patch_note calls,
 * each diff-card-gated per ADR-016 D2).
 */
export const TAG_NORMALIZE_RULE_NAME = 'normalize-tag';

export interface TagNormalizeLlmJudge {
  /**
   * Decide whether the cluster of tags refers to the same concept.
   * Returns `null` (cluster is NOT the same concept; drop the
   * finding) or the canonical tag (without `#`) the judge picked.
   * May throw; caller treats throws as "not the same concept".
   */
  judge(cluster: string[]): Promise<string | null>;
}

export interface TagNormalizeRuleOptions {
  llmJudge: TagNormalizeLlmJudge;
  /**
   * Max edit distance between tags to consider them potentially the
   * same. Default 2 (catches singular/plural + minor typos; rejects
   * "design" vs "decision").
   */
  maxEditDistance?: number;
  /** Per-sweep LLM call cap per ADR-022 D6. Default 50. */
  maxLlmCalls?: number;
  /** Minimum cluster size (number of distinct tags) to consider. Default 2. */
  minClusterSize?: number;
  /** Tags to ignore (e.g., system tags). Default empty. */
  ignoredTags?: string[];
}

const DEFAULT_MAX_EDIT_DISTANCE = 2;
const DEFAULT_MAX_LLM_CALLS = 50;
const DEFAULT_MIN_CLUSTER_SIZE = 2;

export function makeTagNormalizeRule(opts: TagNormalizeRuleOptions): CuratorRule {
  const maxEditDistance = opts.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE;
  const maxLlmCalls = opts.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const minClusterSize = opts.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
  const ignored = new Set((opts.ignoredTags ?? []).map((t) => t.toLowerCase()));

  return {
    name: TAG_NORMALIZE_RULE_NAME,
    detect: async (corpus) => {
      const tagCounts = await enumerateTags(corpus);
      // Drop ignored tags.
      for (const ignoredTag of ignored) {
        tagCounts.delete(ignoredTag);
      }
      if (tagCounts.size === 0) {
        return [];
      }
      const clusters = clusterTags(
        [...tagCounts.keys()],
        maxEditDistance,
      ).filter((c) => c.length >= minClusterSize);

      // Larger clusters first (more notes affected = higher value).
      clusters.sort((a, b) => clusterWeight(b, tagCounts) - clusterWeight(a, tagCounts));

      const findings: CuratorFinding[] = [];
      let llmCalls = 0;
      for (const cluster of clusters) {
        if (llmCalls >= maxLlmCalls) {
          break;
        }
        llmCalls += 1;
        let canonical: string | null;
        try {
          canonical = await opts.llmJudge.judge([...cluster]);
        } catch {
          continue;
        }
        if (canonical === null) {
          continue;
        }
        // The first note that uses any non-canonical cluster member —
        // we attach the finding to that note (the apply path will fan
        // out to all notes using any non-canonical member).
        const nonCanonicalCount = cluster
          .filter((t) => t !== canonical.toLowerCase())
          .reduce((sum, t) => sum + (tagCounts.get(t) ?? 0), 0);
        findings.push({
          ruleName: TAG_NORMALIZE_RULE_NAME,
          notePath: '', // cluster-wide, not note-bound
          severity: severityFromClusterSize(cluster.length),
          reason: `${cluster.length} tag variants — canonicalize to \`#${canonical}\` across ${nonCanonicalCount} note(s)`,
          payload: {
            cluster,
            canonical: canonical.toLowerCase(),
            nonCanonicalNoteCount: nonCanonicalCount,
          },
        });
      }
      return findings;
    },
  };
}

/**
 * Walk every markdown file in the corpus and count tag occurrences.
 * Tags come from two places per ADR-013 §3 / Obsidian convention:
 *   1. `#tag` inline references in body (excluding `#heading` lines)
 *   2. `tags: [...]` or `tags:\n  - x` in YAML frontmatter
 *
 * Returns a `Map<lowercaseTag, occurrenceCount>`. Exported for tests.
 */
export async function enumerateTags(corpus: CuratorCorpus): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const path of await corpus.listAllMarkdown()) {
    let content: string;
    try {
      content = await corpus.read(path);
    } catch {
      continue;
    }
    for (const tag of extractTags(content)) {
      const k = tag.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Extract tags from one note's content. Inline `#tag` + frontmatter
 * `tags:` list. Exported for tests.
 *
 * Inline rule: `#word` at start of line or after whitespace, word
 * chars + `-`/`_`/`/`. Excludes pure-number forms (`#1`) and
 * heading lines (`#`, `##`, etc.).
 */
export function extractTags(content: string): string[] {
  const tags: string[] = [];
  // Frontmatter tags.
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const afterStart = content.indexOf('\n') + 1;
    const closeIdx = content.indexOf('\n---', afterStart);
    if (closeIdx !== -1) {
      const block = content.slice(afterStart, closeIdx);
      // tags: [foo, bar]   OR   tags: foo   OR   tags:\n  - foo\n  - bar
      const inlineMatch = /^tags\s*:\s*\[([^\]]*)\]/m.exec(block);
      if (inlineMatch !== null) {
        for (const part of inlineMatch[1].split(',')) {
          const t = part.trim().replace(/^['"]|['"]$/g, '');
          if (t.length > 0) {
            tags.push(t);
          }
        }
      } else {
        const scalarMatch = /^tags\s*:\s*([^\n]+)$/m.exec(block);
        if (scalarMatch !== null) {
          const v = scalarMatch[1].trim();
          if (v.length > 0 && !v.startsWith('-')) {
            tags.push(v);
          }
        }
        // Block list
        const listMatch = /^tags\s*:\s*\n((?:\s*-\s*[^\n]+\n?)+)/m.exec(block);
        if (listMatch !== null) {
          for (const line of listMatch[1].split('\n')) {
            const m = /^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(line);
            if (m !== null && m[1].length > 0) {
              tags.push(m[1]);
            }
          }
        }
      }
    }
  }
  // Inline #tags (skip heading lines, code fences, and pure-number forms).
  const lines = content.split('\n');
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#+\s/.test(line)) {
      // heading
      continue;
    }
    const re = /(?:^|\s)#([A-Za-z][A-Za-z0-9_\-/]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      tags.push(m[1]);
    }
  }
  return tags;
}

/**
 * Cluster tags that are within `maxEditDistance` of each other under
 * case-insensitive comparison. Single-pass union-find approximation:
 * each tag joins the first cluster whose representative is close.
 * O(N²) in the number of distinct tags — fine for vaults with up to
 * a few thousand tags. Exported for tests.
 */
export function clusterTags(tags: string[], maxEditDistance: number): string[][] {
  const sorted = [...new Set(tags.map((t) => t.toLowerCase()))].sort();
  const clusters: string[][] = [];
  for (const tag of sorted) {
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.some((c) => editDistance(c, tag) <= maxEditDistance)) {
        cluster.push(tag);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([tag]);
    }
  }
  return clusters;
}

/**
 * Levenshtein distance between `a` and `b`. Exported for tests so
 * we can sanity-check the cluster math.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    prev[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j];
    }
  }
  return prev[b.length];
}

/**
 * 0.4 base + 0.05 per cluster member, capped at 0.65. Exported for
 * tests.
 */
export function severityFromClusterSize(size: number): number {
  return Math.min(0.65, 0.4 + size * 0.05);
}

function clusterWeight(cluster: string[], counts: Map<string, number>): number {
  let total = 0;
  for (const t of cluster) {
    total += counts.get(t) ?? 0;
  }
  return total;
}
