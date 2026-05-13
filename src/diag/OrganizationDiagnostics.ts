import type { ActivityLog } from '../activity/ActivityLog';
import type { ActivityEventKind } from '../activity/types';
import type { SuggestionQueue } from '../organization/SuggestionQueue';
import type { SagittariusSettings } from '../settings/types';

/**
 * v0.8.1 — gather state from every Phase 5/6 subsystem into a single
 * structured snapshot. Pure(ish): all I/O is delegated through the
 * injected dependencies so the helper is testable.
 *
 * Per ADR-019 D3 sub-decision + ADR-018 lesson 3. Closes the
 * DevTools-eval gap that made Phase 5 smoke tests slow.
 */
export interface DiagnosticsSnapshot {
  pluginVersion: string;
  activityLog: ActivityLogSnapshot | null;
  suggestionQueue: SuggestionQueueSnapshot | null;
  organization: OrganizationSnapshot;
  retrieval: RetrievalSnapshot;
}

export interface ActivityLogSnapshot {
  size: number;
  byKind: Record<ActivityEventKind, number>;
}

export interface SuggestionQueueSnapshot {
  total: number;
  visible: number;
  deferred: number;
  byKind: { route: number; mocAdd: number };
}

export interface OrganizationSnapshot {
  enabled: boolean;
  watchedFolders: string[];
  classifierModel: string;
  minConfidence: number;
  sweepIntervalSec: number;
  mocFoldersConfigured: number;
}

export interface RetrievalSnapshot {
  hfTokenSet: boolean;
  anthropicKeySet: boolean;
  engineLoaded: boolean;
  indexing: boolean;
}

export interface DiagnosticsDeps {
  pluginVersion: string;
  settings: SagittariusSettings;
  activityLog: ActivityLog | null;
  suggestionQueue: SuggestionQueue | null;
  engineLoaded: boolean;
  isIndexing: boolean;
}

/** Collect a snapshot. All async work is reads — no side effects. */
export async function gatherDiagnostics(deps: DiagnosticsDeps): Promise<DiagnosticsSnapshot> {
  const activityLog = deps.activityLog === null
    ? null
    : await snapshotActivityLog(deps.activityLog);
  const suggestionQueue =
    deps.suggestionQueue === null ? null : await snapshotSuggestionQueue(deps.suggestionQueue, deps.settings.organizationMinConfidence);

  return {
    pluginVersion: deps.pluginVersion,
    activityLog,
    suggestionQueue,
    organization: {
      enabled: deps.settings.organizationEnabled,
      watchedFolders: [...deps.settings.organizationWatchedFolders],
      classifierModel: deps.settings.organizationClassifierModel,
      minConfidence: deps.settings.organizationMinConfidence,
      sweepIntervalSec: deps.settings.organizationSweepIntervalSec,
      mocFoldersConfigured: deps.settings.organizationMocFolders.length,
    },
    retrieval: {
      hfTokenSet: deps.settings.huggingfaceApiKey.length > 0,
      anthropicKeySet: deps.settings.apiKey.length > 0,
      engineLoaded: deps.engineLoaded,
      indexing: deps.isIndexing,
    },
  };
}

async function snapshotActivityLog(log: ActivityLog): Promise<ActivityLogSnapshot> {
  const all = await log.list();
  const byKind: Record<ActivityEventKind, number> = {
    'index.built': 0,
    'classifier.ran': 0,
    'suggestion.enqueued': 0,
    'suggestion.applied': 0,
    'suggestion.rejected': 0,
    'suggestion.skipped': 0,
    'write.committed': 0,
    'write.undone': 0,
    error: 0,
    diagnostic: 0,
  };
  for (const event of all) {
    byKind[event.kind] += 1;
  }
  return { size: all.length, byKind };
}

async function snapshotSuggestionQueue(
  queue: SuggestionQueue,
  minConfidence: number,
): Promise<SuggestionQueueSnapshot> {
  const total = await queue.size();
  const all = await queue.list({ includeDeferred: true, minConfidence: 0 });
  const visible = await queue.list({ includeDeferred: true, minConfidence });
  const deferred = all.filter((s) => s.deferred === true).length;
  let route = 0;
  let mocAdd = 0;
  for (const s of all) {
    if (s.kind === 'route') {
      route += 1;
    } else {
      mocAdd += 1;
    }
  }
  return {
    total,
    visible: visible.length,
    deferred,
    byKind: { route, mocAdd },
  };
}

/**
 * Render a snapshot as a human-readable multi-line report. Mirrors the
 * Phase 3 System Check format. Exported separately from
 * `gatherDiagnostics` so the command can print it to console + bundle it
 * into the `diagnostic` event's details payload.
 */
export function formatDiagnosticsReport(snap: DiagnosticsSnapshot): string {
  const lines: string[] = [];
  lines.push('Sagittarius diagnostics report:');
  lines.push(`  Plugin version          ${snap.pluginVersion}`);

  lines.push('');
  lines.push('  Retrieval:');
  lines.push(`    Anthropic API key     ${snap.retrieval.anthropicKeySet ? 'set' : 'MISSING'}`);
  lines.push(`    HuggingFace token     ${snap.retrieval.hfTokenSet ? 'set' : 'MISSING'}`);
  lines.push(`    Engine loaded         ${snap.retrieval.engineLoaded ? 'yes' : 'no'}`);
  lines.push(`    Currently indexing    ${snap.retrieval.indexing ? 'yes' : 'no'}`);

  lines.push('');
  lines.push('  Organization (Phase 5):');
  lines.push(`    Enabled               ${snap.organization.enabled ? 'yes' : 'no'}`);
  lines.push(`    Watched folders       ${snap.organization.watchedFolders.join(', ') || '(none)'}`);
  lines.push(`    Classifier model      ${snap.organization.classifierModel}`);
  lines.push(`    Min confidence        ${snap.organization.minConfidence}`);
  lines.push(`    Sweep interval (sec)  ${snap.organization.sweepIntervalSec}`);
  lines.push(`    MOC folders           ${snap.organization.mocFoldersConfigured}`);

  if (snap.suggestionQueue !== null) {
    lines.push('');
    lines.push('  Suggestion queue:');
    lines.push(`    Total                 ${snap.suggestionQueue.total}`);
    lines.push(`    Visible (>= min)      ${snap.suggestionQueue.visible}`);
    lines.push(`    Deferred              ${snap.suggestionQueue.deferred}`);
    lines.push(`    Route / MOC-add       ${snap.suggestionQueue.byKind.route} / ${snap.suggestionQueue.byKind.mocAdd}`);
  } else {
    lines.push('');
    lines.push('  Suggestion queue:       (engine off)');
  }

  if (snap.activityLog !== null) {
    lines.push('');
    lines.push('  Activity log (Phase 6):');
    lines.push(`    Total events          ${snap.activityLog.size}`);
    for (const [kind, count] of Object.entries(snap.activityLog.byKind)) {
      if (count > 0) {
        lines.push(`      ${kind.padEnd(20)}${count}`);
      }
    }
  } else {
    lines.push('');
    lines.push('  Activity log:           (off)');
  }

  return lines.join('\n');
}

/** One-line headline for the activity stream event + the closing Notice. */
export function formatDiagnosticsSummary(snap: DiagnosticsSnapshot): string {
  const parts: string[] = [];
  parts.push(`org=${snap.organization.enabled ? 'on' : 'off'}`);
  if (snap.suggestionQueue !== null) {
    parts.push(`queue=${snap.suggestionQueue.total}`);
  }
  if (snap.activityLog !== null) {
    parts.push(`activity=${snap.activityLog.size}`);
  }
  parts.push(`index=${snap.retrieval.engineLoaded ? 'loaded' : 'off'}`);
  return parts.join(', ');
}
