import type { CuratorRule } from '../CuratorRule';
import type { CuratorFinding } from '../types';

/**
 * Phase 7 (v1.0.2) — embedding-based duplicate-candidate detector
 * per ADR-022 D1 (v1.x LLM-judged row).
 *
 * Pure-rule + LLM-judged hybrid per ADR-022 D3:
 *   1. **Pre-filter (cheap):** ask `similarityFinder` for the top-K
 *      embedding-similar notes per source note. Drops anything below
 *      `threshold` (default 0.85 cosine).
 *   2. **Dedup (cheap):** each pair counted once via lexicographic
 *      min/max ordering.
 *   3. **Budget cap (cheap):** stop generating findings once the
 *      per-sweep `maxLlmCalls` is hit. Configurable per ADR-022 D6
 *      to keep cost bounded.
 *   4. **LLM confirm (expensive):** ask `llmJudge` whether the two
 *      notes are actually about the same thing. Only confirmed pairs
 *      become findings.
 *
 * Output: one `CuratorFinding` per confirmed pair. Severity is
 * 0.5 + similarity × 0.3 (range 0.5..0.8). The pair is encoded as
 * `notePath` (the first of the pair) + `payload.otherPath`.
 *
 * The finding is informational — apply path is informational-only
 * (open both notes side-by-side; merge is Phase 8 per ADR-022 D1).
 */
export const DUPLICATE_CANDIDATE_RULE_NAME = 'duplicate-candidate';

export interface SimilarityFinder {
  /**
   * Return the top-K notes most similar to `notePath`, excluding
   * `notePath` itself. Each result carries a similarity score
   * (typically cosine similarity, 0..1).
   */
  findSimilar(
    notePath: string,
    k: number,
  ): Promise<Array<{ path: string; score: number }>>;
}

export interface LlmJudge {
  /**
   * Decide whether the two notes are duplicates. Inputs are the two
   * note contents (already truncated by the caller if needed).
   * Returns true if duplicates, false otherwise. May throw on rate
   * limits / API errors — the rule catches and treats as "not a
   * duplicate" (false-negative is safer than a false-positive merge
   * proposal).
   */
  judge(
    a: { path: string; content: string },
    b: { path: string; content: string },
  ): Promise<boolean>;
}

export interface DuplicateCandidateRuleOptions {
  similarityFinder: SimilarityFinder;
  llmJudge: LlmJudge;
  /** Cosine similarity floor. Default 0.85 per ADR-022 D1. */
  threshold?: number;
  /** How many similar candidates to consider per source note. Default 3. */
  topK?: number;
  /** Per-sweep LLM call cap per ADR-022 D6. Default 50. */
  maxLlmCalls?: number;
  /** Max content sent to the judge per note (chars). Default 4000. */
  maxContentChars?: number;
}

const DEFAULT_THRESHOLD = 0.85;
const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_LLM_CALLS = 50;
const DEFAULT_MAX_CONTENT_CHARS = 4000;

export function makeDuplicateCandidateRule(
  opts: DuplicateCandidateRuleOptions,
): CuratorRule {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const maxLlmCalls = opts.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const maxContentChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;

  return {
    name: DUPLICATE_CANDIDATE_RULE_NAME,
    detect: async (corpus) => {
      const allMd = await corpus.listAllMarkdown();
      const seenPairs = new Set<string>();
      const candidatePairs: Array<{ a: string; b: string; score: number }> = [];

      // Phase 1: gather all similar pairs above threshold, deduped.
      for (const sourcePath of allMd) {
        let similar: Array<{ path: string; score: number }>;
        try {
          similar = await opts.similarityFinder.findSimilar(sourcePath, topK);
        } catch {
          continue;
        }
        for (const candidate of similar) {
          if (candidate.score < threshold) {
            continue;
          }
          if (candidate.path === sourcePath) {
            continue;
          }
          const pairKey =
            sourcePath < candidate.path
              ? `${sourcePath}|${candidate.path}`
              : `${candidate.path}|${sourcePath}`;
          if (seenPairs.has(pairKey)) {
            continue;
          }
          seenPairs.add(pairKey);
          const a = sourcePath < candidate.path ? sourcePath : candidate.path;
          const b = sourcePath < candidate.path ? candidate.path : sourcePath;
          candidatePairs.push({ a, b, score: candidate.score });
        }
      }

      // Sort by similarity desc so the budget cap keeps the
      // highest-signal pairs.
      candidatePairs.sort((p, q) => q.score - p.score);

      // Phase 2: LLM confirm, budget-capped.
      const findings: CuratorFinding[] = [];
      let llmCalls = 0;
      for (const pair of candidatePairs) {
        if (llmCalls >= maxLlmCalls) {
          break;
        }
        let contentA: string;
        let contentB: string;
        try {
          contentA = await corpus.read(pair.a);
          contentB = await corpus.read(pair.b);
        } catch {
          continue;
        }
        llmCalls += 1;
        let confirmed: boolean;
        try {
          confirmed = await opts.llmJudge.judge(
            { path: pair.a, content: truncate(contentA, maxContentChars) },
            { path: pair.b, content: truncate(contentB, maxContentChars) },
          );
        } catch {
          continue;
        }
        if (!confirmed) {
          continue;
        }
        findings.push({
          ruleName: DUPLICATE_CANDIDATE_RULE_NAME,
          notePath: pair.a,
          severity: severityFromSimilarity(pair.score),
          reason: `Looks like a duplicate of [[${stripMdSuffix(pair.b)}]] (cosine ≥ ${threshold.toFixed(2)})`,
          payload: {
            otherPath: pair.b,
            similarity: pair.score,
          },
        });
      }
      return findings;
    },
  };
}

/**
 * Map cosine similarity to a 0.5..0.8 severity score. Exported for
 * tests. Capped because (a) duplicates are informational only in
 * v1.0.2 (no automated merge), and (b) we don't want them outranking
 * broken-link findings (0.9) which are unambiguous.
 */
export function severityFromSimilarity(score: number): number {
  const clamped = Math.max(0, Math.min(1, score));
  return 0.5 + clamped * 0.3;
}

function truncate(content: string, max: number): string {
  if (content.length <= max) {
    return content;
  }
  return `${content.slice(0, max)}\n\n[…truncated]`;
}

function stripMdSuffix(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path;
}
