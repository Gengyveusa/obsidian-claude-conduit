import type { ActivityEvent } from '../activity/types';
import type { CuratorFinding } from '../curator/types';
import type { DraftRecord } from '../drafts/DraftStore';
import type { CascadeResult } from '../memory/MemoryCascade';

import { briefingPathFor } from './paths';

/**
 * Phase 14 (v1.7.0) — pure briefing renderer per ADR-035 D5.
 *
 * Takes pre-fetched snapshots of every subsystem the briefing
 * summarizes (curator findings, activity events, draft backlog,
 * synthesis candidates, memory state, recent journal "open threads")
 * and produces the markdown body of the day's briefing.
 *
 * The plugin layer orchestrates data gathering (running the curator,
 * reading the activity log, listing drafts, etc.) then hands the
 * snapshot to this composer. Keeping the composer pure makes every
 * section testable in isolation without spinning up the live
 * subsystems.
 *
 * Mirrors the pattern of `AnthropicJournalGenerator` minus the LLM
 * call (the briefing's deterministic sections need no model; the
 * optional editorial summary per D4 is generated separately by the
 * plugin layer and passed in as `opts.editorialText`).
 */

/** Six fixed sections per ADR-035 D3, plus the optional editorial. */
export interface BriefingData {
  /** YYYY-MM-DD label for the H1 header. */
  date: string;
  /** "What changed yesterday" — events from the prior 24h window. */
  activityYesterday: ActivityEvent[];
  /** Curator findings (broken links, orphans, stale, schema, dupes, tags). */
  curatorFindings: CuratorFinding[];
  /** Pending drafts under `_drafts/` from `DraftStore`. */
  draftBacklog: DraftRecord[];
  /** Draft-suggestion findings (tag clusters lacking synthesis). */
  synthesisOpportunities: CuratorFinding[];
  /** Memory state from the cascade preview. */
  memoryState: {
    cascade: CascadeResult | null;
    recentJournalPaths: string[];
  };
  /**
   * Bullet strings extracted from recent journals'
   * `- **Open threads:**` lines. The composer renders these
   * verbatim; the plugin layer does the journal parsing.
   */
  openThreads: string[];
}

export interface BriefingComposeOptions {
  /**
   * Per ADR-035 D4 — operator-supplied 2-3 sentence editorial summary.
   * When provided, renders above the six sections as a blockquote.
   * When `null`, the section is omitted entirely (deterministic
   * briefing only).
   */
  editorialText: string | null;
  /**
   * OQ3 hedge — cap items per section to keep the briefing
   * scannable. Excess items render a "+ N more" line at the
   * bottom of the section. Default 10.
   */
  maxItemsPerSection?: number;
}

export interface BriefingComposeResult {
  /** Full markdown body, ready to write via `create_note`. */
  content: string;
  /** True if any of the six sections had content (vs. all empty). */
  hasContent: boolean;
  /**
   * Per-section item counts after the cap is applied. Useful for
   * status-bar pill text ("Briefing: 5 items").
   */
  itemCounts: BriefingItemCounts;
}

export interface BriefingItemCounts {
  activity: number;
  curator: number;
  drafts: number;
  synthesis: number;
  openThreads: number;
  /** Sum across all sections. */
  total: number;
}

/**
 * Compose the briefing markdown from pre-fetched data.
 *
 * @example
 *   const result = composeBriefing({
 *     date: '2026-05-16',
 *     activityYesterday: events,
 *     curatorFindings: findings,
 *     // ...
 *   }, { editorialText: null });
 *   await tools.execute('create_note', { path, content: result.content });
 */
export function composeBriefing(
  data: BriefingData,
  opts: BriefingComposeOptions,
): BriefingComposeResult {
  const cap = Math.max(1, opts.maxItemsPerSection ?? 10);
  const itemCounts: BriefingItemCounts = {
    activity: data.activityYesterday.length,
    curator: data.curatorFindings.length,
    drafts: data.draftBacklog.length,
    synthesis: data.synthesisOpportunities.length,
    openThreads: data.openThreads.length,
    total: 0,
  };
  itemCounts.total =
    itemCounts.activity +
    itemCounts.curator +
    itemCounts.drafts +
    itemCounts.synthesis +
    itemCounts.openThreads;

  const parts: string[] = [];
  parts.push(`# Briefing: ${data.date}`);
  parts.push('');

  // D4 editorial — optional blockquote at the top.
  if (opts.editorialText !== null && opts.editorialText.trim().length > 0) {
    const quoted = opts.editorialText
      .trim()
      .split('\n')
      .map((line) => `> ${line.trim()}`)
      .join('\n');
    parts.push(quoted);
    parts.push('');
  }

  parts.push(renderActivitySection(data.activityYesterday, cap));
  parts.push('');
  parts.push(renderCuratorSection(data.curatorFindings, cap));
  parts.push('');
  parts.push(renderDraftingSection(data.draftBacklog, cap));
  parts.push('');
  parts.push(renderSynthesisSection(data.synthesisOpportunities, cap));
  parts.push('');
  parts.push(renderMemorySection(data.memoryState));
  parts.push('');
  parts.push(renderOpenThreadsSection(data.openThreads, cap));

  return {
    content: parts.join('\n').trimEnd() + '\n',
    hasContent: itemCounts.total > 0,
    itemCounts,
  };
}

function renderActivitySection(events: ReadonlyArray<ActivityEvent>, cap: number): string {
  const lines: string[] = [`## What changed yesterday (${events.length})`, ''];
  if (events.length === 0) {
    lines.push('(nothing to flag)');
    return lines.join('\n');
  }
  const shown = events.slice(0, cap);
  // Newest-first by timestamp.
  const sorted = [...shown].sort((a, b) => b.timestamp - a.timestamp);
  for (const e of sorted) {
    const stamp = new Date(e.timestamp).toISOString().slice(11, 16);
    lines.push(`- \`${stamp}\` \`${e.kind}\`${formatEventSummary(e)}`);
  }
  if (events.length > cap) {
    lines.push(`- _+ ${events.length - cap} more (see activity stream)_`);
  }
  return lines.join('\n');
}

function formatEventSummary(e: ActivityEvent): string {
  // Pull a useful short summary from common event shapes; fall back
  // to source attribution.
  const src = e.source !== undefined && e.source.length > 0 ? ` _(${e.source})_` : '';
  if ('toolName' in e && typeof (e as { toolName?: unknown }).toolName === 'string') {
    return ` — ${(e as { toolName: string }).toolName}${src}`;
  }
  if ('notePath' in e && typeof (e as { notePath?: unknown }).notePath === 'string') {
    return ` — \`${(e as { notePath: string }).notePath}\`${src}`;
  }
  return src;
}

function renderCuratorSection(findings: ReadonlyArray<CuratorFinding>, cap: number): string {
  const highCount = findings.filter((f) => f.severity >= 0.7).length;
  const heading =
    findings.length === 0
      ? '## Curator suggestions (0)'
      : `## Curator suggestions ⚠ (${highCount} high, ${findings.length} total)`;
  const lines: string[] = [heading, ''];
  if (findings.length === 0) {
    lines.push('(nothing to flag)');
    return lines.join('\n');
  }
  // Severity-sorted desc.
  const sorted = [...findings].sort((a, b) => b.severity - a.severity);
  const shown = sorted.slice(0, cap);
  for (const f of shown) {
    const sevLabel = severityLabel(f.severity);
    lines.push(
      `- ${sevLabel} \`${f.notePath}\` — ${f.reason} _(rule: ${f.ruleName})_`,
    );
  }
  if (findings.length > cap) {
    lines.push(`- _+ ${findings.length - cap} more (run \`Sagittarius: Run curator\`)_`);
  }
  return lines.join('\n');
}

function severityLabel(s: number): string {
  if (s >= 0.85) {return '🔴';}
  if (s >= 0.7) {return '🟠';}
  if (s >= 0.4) {return '🟡';}
  return '⚪';
}

function renderDraftingSection(drafts: ReadonlyArray<DraftRecord>, cap: number): string {
  const lines: string[] = [`## Drafting backlog (${drafts.length})`, ''];
  if (drafts.length === 0) {
    lines.push('(no pending drafts)');
    return lines.join('\n');
  }
  // Newest-first by generatedAt; nulls last.
  const sorted = [...drafts].sort((a, b) => {
    if (a.generatedAt === null && b.generatedAt === null) {return 0;}
    if (a.generatedAt === null) {return 1;}
    if (b.generatedAt === null) {return -1;}
    return b.generatedAt - a.generatedAt;
  });
  const shown = sorted.slice(0, cap);
  for (const d of shown) {
    const title = d.topic ?? d.firstHeading ?? d.path;
    const citeCount = d.citedChunksCount;
    lines.push(
      `- [[${d.path}|${title}]] — ${citeCount} citation${citeCount === 1 ? '' : 's'}`,
    );
  }
  if (drafts.length > cap) {
    lines.push(`- _+ ${drafts.length - cap} more (see drafts panel)_`);
  }
  return lines.join('\n');
}

function renderSynthesisSection(
  candidates: ReadonlyArray<CuratorFinding>,
  cap: number,
): string {
  const lines: string[] = [
    `## Synthesis opportunities (${candidates.length})`,
    '',
  ];
  if (candidates.length === 0) {
    lines.push('(no tag clusters lacking synthesis)');
    return lines.join('\n');
  }
  const sorted = [...candidates].sort((a, b) => b.severity - a.severity);
  const shown = sorted.slice(0, cap);
  for (const c of shown) {
    // Per the DraftSuggestionRule payload shape: `{ tag, memberCount, ... }`.
    const payload = c.payload as { tag?: string; memberCount?: number } | undefined;
    const tag = payload?.tag ?? '(unknown)';
    const count = payload?.memberCount ?? 0;
    lines.push(`- \`#${tag}\` — ${count} notes lacking a synthesis (\`${c.reason}\`)`);
  }
  if (candidates.length > cap) {
    lines.push(`- _+ ${candidates.length - cap} more (run \`Sagittarius: Suggest drafts\`)_`);
  }
  return lines.join('\n');
}

function renderMemorySection(memoryState: BriefingData['memoryState']): string {
  const lines: string[] = ['## Memory state', ''];
  const cascade = memoryState.cascade;
  if (cascade === null) {
    lines.push('- Memory cascade: **off**');
  } else if (cascade.sections.length === 0) {
    lines.push('- Memory cascade: enabled but no `CLAUDE.md` files match the current cascade');
  } else {
    const kb = (cascade.totalBytes / 1024).toFixed(1);
    lines.push(`- Memory cascade: ${kb}KB across ${cascade.sections.length} file(s)`);
    for (const section of cascade.sections) {
      lines.push(`  - \`${section.path}\``);
    }
    if (cascade.budgetHit) {
      lines.push('  - ⚠ budget hit — some content was truncated');
    }
  }
  if (memoryState.recentJournalPaths.length > 0) {
    lines.push(
      `- Recent journals: ${memoryState.recentJournalPaths
        .map((p) => `\`${p}\``)
        .join(', ')}`,
    );
  } else {
    lines.push('- Recent journals: none');
  }
  return lines.join('\n');
}

function renderOpenThreadsSection(threads: ReadonlyArray<string>, cap: number): string {
  const lines: string[] = [`## Open threads from journals (${threads.length})`, ''];
  if (threads.length === 0) {
    lines.push('(no open threads recorded; run `Sagittarius: Journal this session` to add some)');
    return lines.join('\n');
  }
  const shown = threads.slice(0, cap);
  for (const t of shown) {
    lines.push(`- ${t}`);
  }
  if (threads.length > cap) {
    lines.push(`- _+ ${threads.length - cap} more_`);
  }
  return lines.join('\n');
}

/**
 * Convenience — produces the destination path for the briefing
 * using the same path helper as `briefingPathFor`. Exposed for
 * callers that want one-stop access without importing from `./paths`.
 */
export function briefingPathForResult(now: Date, timezone: string): string {
  return briefingPathFor(now, timezone);
}
