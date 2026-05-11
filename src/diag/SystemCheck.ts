import type { MessagesAPI } from '../agent/ConduitAgent';
import type { VaultAdapter } from '../agent/types';
import type { EmbedClient } from '../retrieval/EmbedClient';
import type { RetrievalLayer } from '../retrieval/RetrievalLayer';
import type { SqliteEngine } from '../retrieval/SqliteEngine';

/** Result of a single check. */
export interface CheckResult {
  /** Human-readable label, shown in the report. */
  name: string;
  /** `pass` = green; `warn` = yellow (degraded but not broken); `fail` = red. */
  status: 'pass' | 'warn' | 'fail';
  /** Wall-clock time spent on this check, ms. */
  durationMs: number;
  /** Short detail string — error message on fail, a number on pass, etc. */
  detail: string;
}

/** Aggregate report. */
export interface SystemCheckReport {
  results: CheckResult[];
  /** Sum of all `durationMs`. */
  totalMs: number;
  /** Counts for the summary Notice. */
  passCount: number;
  warnCount: number;
  failCount: number;
}

export interface SystemCheckDeps {
  /**
   * Plugin version from manifest.json (i.e. `this.manifest.version`).
   * Used both for the version-coherence check and for reporting which
   * build is being audited.
   */
  manifestVersion: string;
  /** Whether the user has set an Anthropic API key in settings. */
  hasAnthropicKey: boolean;
  /** Whether the user has set an HF token. Optional — retrieval degrades gracefully. */
  hasHuggingFaceKey: boolean;
  /** Live Anthropic messages client. Null if no key set. */
  anthropic: MessagesAPI | null;
  /** Default model id from settings — used for the round-trip ping. */
  defaultModel: string;
  /** Vault adapter. */
  adapter: VaultAdapter;
  /** SQLite engine. Always present (opened during plugin onload). */
  engine: SqliteEngine;
  /** EmbedClient. Null if no HF token set. */
  embedClient: EmbedClient | null;
  /** RetrievalLayer. Null if no HF token set. */
  retrieval: RetrievalLayer | null;
}

/**
 * Run end-to-end health checks against the live plugin stack. Designed to
 * surface the kind of bugs that escaped v0.2.x in a single sub-second
 * command (CORS, dead URLs, silent walker failures, missing keys).
 *
 * Returns a `SystemCheckReport` synchronously serializable for display
 * in a Notice + console.warn. Does NOT throw — each check catches its
 * own failure and continues. Total wall-clock is bounded by the slowest
 * check (the Anthropic round-trip, typically 1-3s) plus the HF encode
 * (1-2s). Other checks are sub-millisecond.
 *
 * @example
 *   const checker = new SystemCheck(deps);
 *   const report = await checker.run();
 *   new Notice(formatSummary(report));
 */
export class SystemCheck {
  constructor(private readonly deps: SystemCheckDeps) {}

  async run(): Promise<SystemCheckReport> {
    const results: CheckResult[] = [];

    results.push(this.checkVersionMatch());
    results.push(this.checkAnthropicKey());
    results.push(await this.checkAnthropicLive());
    results.push(this.checkHuggingFaceKey());
    results.push(await this.checkHuggingFaceLive());
    results.push(await this.checkVaultEnumerable());
    results.push(this.checkEngineOpen());
    results.push(this.checkIndexPopulated());
    results.push(await this.checkRetrievalRoundTrip());

    let totalMs = 0;
    let passCount = 0;
    let warnCount = 0;
    let failCount = 0;
    for (const r of results) {
      totalMs += r.durationMs;
      if (r.status === 'pass') {
        passCount++;
      } else if (r.status === 'warn') {
        warnCount++;
      } else {
        failCount++;
      }
    }
    return { results, totalMs, passCount, warnCount, failCount };
  }

  private checkVersionMatch(): CheckResult {
    const start = Date.now();
    const v = this.deps.manifestVersion;
    const ok = /^\d+\.\d+\.\d+$/.test(v);
    return {
      name: 'Plugin version',
      status: ok ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      detail: ok ? v : `malformed manifest version: "${v}"`,
    };
  }

  private checkAnthropicKey(): CheckResult {
    const start = Date.now();
    return {
      name: 'Anthropic API key set',
      status: this.deps.hasAnthropicKey ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      detail: this.deps.hasAnthropicKey
        ? 'present'
        : 'missing — set it in Settings → Sagittarius → API key',
    };
  }

  private async checkAnthropicLive(): Promise<CheckResult> {
    const start = Date.now();
    if (!this.deps.anthropic) {
      return {
        name: 'Anthropic API reachable',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: 'skipped — no API key',
      };
    }
    try {
      const res = await this.deps.anthropic.create({
        model: this.deps.defaultModel,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with exactly "ok".' }],
      });
      const text =
        res.content.find((c) => c.type === 'text')?.text ?? '';
      return {
        name: 'Anthropic API reachable',
        status: 'pass',
        durationMs: Date.now() - start,
        detail: `${this.deps.defaultModel}, ${res.usage.input_tokens}+${res.usage.output_tokens} tok, reply="${text.trim().slice(0, 16)}"`,
      };
    } catch (err) {
      return {
        name: 'Anthropic API reachable',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private checkHuggingFaceKey(): CheckResult {
    const start = Date.now();
    return {
      name: 'HuggingFace token set',
      status: this.deps.hasHuggingFaceKey ? 'pass' : 'warn',
      durationMs: Date.now() - start,
      detail: this.deps.hasHuggingFaceKey
        ? 'present'
        : 'missing — retrieval disabled (chat still works)',
    };
  }

  private async checkHuggingFaceLive(): Promise<CheckResult> {
    const start = Date.now();
    if (!this.deps.embedClient) {
      return {
        name: 'HF Inference reachable',
        status: 'warn',
        durationMs: Date.now() - start,
        detail: 'skipped — no HF token',
      };
    }
    try {
      const vec = await this.deps.embedClient.encode('system check');
      return {
        name: 'HF Inference reachable',
        status: vec.length === 384 ? 'pass' : 'fail',
        durationMs: Date.now() - start,
        detail: `${vec.length}-d vector`,
      };
    } catch (err) {
      return {
        name: 'HF Inference reachable',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkVaultEnumerable(): Promise<CheckResult> {
    const start = Date.now();
    try {
      const paths = await this.deps.adapter.listAllMarkdown();
      return {
        name: 'Vault enumerable',
        status: paths.length > 0 ? 'pass' : 'fail',
        durationMs: Date.now() - start,
        detail: `${paths.length} markdown files`,
      };
    } catch (err) {
      return {
        name: 'Vault enumerable',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private checkEngineOpen(): CheckResult {
    const start = Date.now();
    try {
      const meta = this.deps.engine.getSchemaMeta();
      return {
        name: 'SQLite engine open',
        status: 'pass',
        durationMs: Date.now() - start,
        detail: `writer=${meta.writer} version=${meta.writerVersion}`,
      };
    } catch (err) {
      return {
        name: 'SQLite engine open',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private checkIndexPopulated(): CheckResult {
    const start = Date.now();
    try {
      const noteCount = this.deps.engine.count('notes');
      const chunkCount = this.deps.engine.count('chunks');
      return {
        name: 'Index populated',
        status: chunkCount > 0 ? 'pass' : 'warn',
        durationMs: Date.now() - start,
        detail: `${noteCount} notes, ${chunkCount} chunks` + (chunkCount === 0 ? ' (run Build Index)' : ''),
      };
    } catch (err) {
      return {
        name: 'Index populated',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkRetrievalRoundTrip(): Promise<CheckResult> {
    const start = Date.now();
    if (!this.deps.retrieval) {
      return {
        name: 'Retrieval round-trip',
        status: 'warn',
        durationMs: Date.now() - start,
        detail: 'skipped — no HF token',
      };
    }
    if (this.deps.engine.count('chunks') === 0) {
      return {
        name: 'Retrieval round-trip',
        status: 'warn',
        durationMs: Date.now() - start,
        detail: 'skipped — index empty',
      };
    }
    try {
      const hits = await this.deps.retrieval.queryUnified({ query: 'system check', limit: 1 });
      return {
        name: 'Retrieval round-trip',
        status: 'pass',
        durationMs: Date.now() - start,
        detail: `${hits.length} hit(s)`,
      };
    } catch (err) {
      return {
        name: 'Retrieval round-trip',
        status: 'fail',
        durationMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * One-line summary suitable for a Notice. e.g. "✅ 9/9 passed in 2.1s"
 * or "❌ 7/9 passed, 1 warn, 1 fail in 1.8s".
 */
export function formatSummary(report: SystemCheckReport): string {
  const total = report.passCount + report.warnCount + report.failCount;
  const seconds = (report.totalMs / 1000).toFixed(1);
  if (report.failCount === 0 && report.warnCount === 0) {
    return `Sagittarius system check: ✅ ${report.passCount}/${total} passed in ${seconds}s`;
  }
  const icon = report.failCount > 0 ? '❌' : '⚠️';
  const parts = [`${report.passCount}/${total} passed`];
  if (report.warnCount > 0) {
    parts.push(`${report.warnCount} warn`);
  }
  if (report.failCount > 0) {
    parts.push(`${report.failCount} fail`);
  }
  return `Sagittarius system check: ${icon} ${parts.join(', ')} in ${seconds}s`;
}

/**
 * Multi-line detail block suitable for `console.warn` — one line per check.
 */
export function formatReport(report: SystemCheckReport): string {
  const lines = report.results.map((r) => {
    let icon: string;
    if (r.status === 'pass') {
      icon = '✅';
    } else if (r.status === 'warn') {
      icon = '⚠️';
    } else {
      icon = '❌';
    }
    return `  ${icon} ${r.name.padEnd(28)} ${r.durationMs.toFixed(0).padStart(5)}ms  ${r.detail}`;
  });
  return ['[sagittarius] System check report:', ...lines].join('\n');
}
