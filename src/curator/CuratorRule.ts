import type { CuratorCorpus, CuratorFinding } from './types';

/**
 * Phase 7 (v1.0.0) — `CuratorRule` interface per
 * [ADR-022](../../docs/2026-05-13-adr-022-phase-7-curator-plan.md) D3.
 *
 * Each rule is a pure detector: input = `CuratorCorpus`, output = an
 * array of `CuratorFinding`. Rules MUST be deterministic — same corpus
 * input → same findings, including severity scores. This stability is
 * what lets the orchestrator rank + cap predictably.
 *
 * Rules MUST NOT call LLMs in `detect()`. LLM judgment lives in the
 * optional `confirm()` hook, which the orchestrator invokes on a
 * shortlist of candidate findings AFTER pre-filter (per ADR-022 D6
 * cost controls — the rule pre-filter is the budget guard).
 *
 * @example pure detector (broken wikilinks)
 *   const rule: CuratorRule = {
 *     name: 'broken-link',
 *     detect: async (corpus) => {
 *       const findings: CuratorFinding[] = [];
 *       for (const path of await corpus.listAllMarkdown()) {
 *         for (const target of await corpus.outboundLinks(path)) {
 *           if (!await corpus.stat(`${target}.md`)) {
 *             findings.push({
 *               ruleName: 'broken-link',
 *               notePath: path,
 *               severity: 0.9,
 *               reason: `Link to [[${target}]] but ${target}.md doesn't exist`,
 *               payload: { brokenTarget: target },
 *             });
 *           }
 *         }
 *       }
 *       return findings;
 *     },
 *   };
 */
export interface CuratorRule {
  /**
   * Stable identifier for this rule. Used by:
   * - `CuratorOrchestrator` for registration + error attribution
   * - `SkipPatternStore` (v1.0.3) to key learned skip rules
   * - `CuratorFinding.ruleName` for cross-reference
   *
   * Renaming a rule mid-lifetime should go through a
   * `rules.aliases` migration (see ADR-022 risks table).
   */
  name: string;

  /**
   * Find every hygiene issue this rule cares about in `corpus`.
   *
   * Pure: no LLM calls, no network, no writes. Deterministic over
   * the same corpus state.
   *
   * Performance: may iterate the whole vault. The orchestrator runs
   * rules serially; future PRs may parallelize if needed.
   *
   * Errors: throw on unrecoverable failure. The orchestrator catches
   * and reports per-rule errors in the run outcome (the sweep
   * continues across other rules).
   */
  detect(corpus: CuratorCorpus): Promise<CuratorFinding[]>;

  /**
   * Optional LLM-gated confirm step. The orchestrator may call this
   * AFTER `detect()` produces candidate findings, on a shortlist
   * trimmed by the per-rule LLM budget cap (ADR-022 D6).
   *
   * Return `true` to keep the finding; `false` to drop it.
   *
   * Rules that don't need LLM judgment (broken-link, orphan, stale,
   * missing-frontmatter) omit this hook. Rules that do (duplicate
   * candidates, tag normalization) implement it.
   */
  confirm?(finding: CuratorFinding): Promise<boolean>;
}
