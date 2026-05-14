import type { CuratorRule } from './CuratorRule';
import type { CuratorCorpus, CuratorFinding, CuratorRunOutcome } from './types';

/**
 * Phase 7 (v1.0.0) — `CuratorOrchestrator` per
 * [ADR-022](../../docs/2026-05-13-adr-022-phase-7-curator-plan.md) D6.
 *
 * Single seam between the rule registry and the rest of the plugin.
 * Per ADR-020 lesson 1 (emitter-seam sprawl), we do NOT pass an
 * `activityLog?:` dep into every rule — emission goes through the
 * orchestrator only, and `main.ts` records the run outcome as a
 * single `diagnostic` (or future `curator.swept`) event.
 *
 * **Lifecycle of one sweep:**
 *   1. caller invokes `run({ maxPerSweep: N })`
 *   2. orchestrator iterates registered rules, calling `detect()`
 *   3. errors caught + collected; sweep continues across rules
 *   4. all findings concatenated; severity-sorted desc
 *   5. top `maxPerSweep` kept (rest reported as `capped`)
 *   6. `LLM confirm` hooks run on the top-N for rules that have them
 *      (per-rule `maxLlmCalls` cap from ADR-022 D6 — PR 2+)
 *   7. outcome returned to caller (PR 2 wires the suggestion queue)
 *
 * **PR 1 scope:** orchestrator + rule registry + ranking + cap. No
 * suggestion-queue enqueue. No `confirm` invocation (rules in PR 1
 * are spec-only; first real rules ship in PR 2).
 *
 * @example
 *   const orch = new CuratorOrchestrator({ corpus });
 *   orch.register(brokenLinkRule);
 *   orch.register(orphanRule);
 *   const outcome = await orch.run({ maxPerSweep: 20 });
 *   // outcome.enqueued is the top-20-severity findings; PR 2 turns
 *   // each into a Suggestion + enqueues.
 */
export interface CuratorOrchestratorDeps {
  /** Read-only vault view shared by all rules. */
  corpus: CuratorCorpus;
  /** Test-injectable clock for deterministic durationMs in tests. */
  now?: () => number;
  /** Test-injectable logger. Default writes to `console.warn`. */
  logger?: { warn: (msg: string) => void };
}

export interface CuratorRunOptions {
  /**
   * Max findings to keep after ranking. Default 20 per ADR-022 D6
   * (suggestion-fatigue mitigation). Set higher in tests if needed;
   * production should respect the user-configured setting.
   */
  maxPerSweep?: number;
}

const DEFAULT_MAX_PER_SWEEP = 20;

export class CuratorOrchestrator {
  private readonly corpus: CuratorCorpus;
  private readonly now: () => number;
  private readonly logger: { warn: (msg: string) => void };
  private readonly rules: CuratorRule[] = [];

  constructor(deps: CuratorOrchestratorDeps) {
    this.corpus = deps.corpus;
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { warn: (msg) => console.warn(`[curator] ${msg}`) };
  }

  /**
   * Register a rule. Throws on duplicate `name` so misconfigured
   * registries fail loud rather than silently shadowing.
   */
  register(rule: CuratorRule): void {
    if (this.rules.some((r) => r.name === rule.name)) {
      throw new Error(`CuratorOrchestrator: rule '${rule.name}' already registered`);
    }
    this.rules.push(rule);
  }

  /** Currently registered rule names, in registration order. */
  registeredRuleNames(): string[] {
    return this.rules.map((r) => r.name);
  }

  /**
   * Run every registered rule against the corpus, rank findings by
   * severity, cap at `maxPerSweep`. Returns the outcome — does NOT
   * enqueue into the suggestion queue (that's PR 2's job).
   */
  async run(opts: CuratorRunOptions = {}): Promise<CuratorRunOutcome> {
    const maxPerSweep = opts.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
    const t0 = this.now();
    const collected: CuratorFinding[] = [];
    const errors: Array<{ ruleName: string; message: string }> = [];

    for (const rule of this.rules) {
      try {
        const findings = await rule.detect(this.corpus);
        for (const finding of findings) {
          collected.push(finding);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`rule '${rule.name}' detect() failed: ${message}`);
        errors.push({ ruleName: rule.name, message });
      }
    }

    // Severity-sorted desc; stable on ties (preserves rule registration order
    // for findings produced earlier in the iteration).
    collected.sort((a, b) => b.severity - a.severity);

    let enqueued: CuratorFinding[];
    let capped: number;
    if (maxPerSweep >= collected.length) {
      enqueued = collected;
      capped = 0;
    } else {
      enqueued = collected.slice(0, maxPerSweep);
      capped = collected.length - maxPerSweep;
    }

    return {
      rulesRun: this.rules.length,
      totalDetected: collected.length,
      enqueued,
      capped,
      errors,
      durationMs: this.now() - t0,
    };
  }
}
