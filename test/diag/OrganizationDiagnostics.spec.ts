import { describe, expect, it } from 'vitest';

import type { ActivityLog } from '../../src/activity/ActivityLog';
import type { ActivityEvent, ActivityEventInput } from '../../src/activity/types';
import {
  formatDiagnosticsReport,
  formatDiagnosticsSummary,
  gatherDiagnostics,
} from '../../src/diag/OrganizationDiagnostics';
import type { SuggestionQueue } from '../../src/organization/SuggestionQueue';
import type { Suggestion } from '../../src/organization/types';
import { DEFAULT_SETTINGS, type SagittariusSettings } from '../../src/settings/types';

function fakeActivityLog(events: ActivityEvent[]): ActivityLog {
  return {
    record: (input: ActivityEventInput): Promise<ActivityEvent> => {
      const event: ActivityEvent = { ...input, id: 'x', timestamp: 1 };
      events.push(event);
      return Promise.resolve(event);
    },
    list: () => Promise.resolve([...events]),
    size: () => Promise.resolve(events.length),
    clear: () => {
      events.length = 0;
      return Promise.resolve();
    },
  };
}

function fakeQueue(items: Suggestion[]): SuggestionQueue {
  return {
    add: () => Promise.resolve(true),
    list: (opts) => {
      const minConfidence = opts?.minConfidence ?? 0;
      const includeDeferred = opts?.includeDeferred ?? true;
      return Promise.resolve(
        items.filter(
          (s) => s.confidence >= minConfidence && (includeDeferred || s.deferred !== true),
        ),
      );
    },
    remove: () => Promise.resolve(null),
    defer: () => Promise.resolve(null),
    hasForNote: () => Promise.resolve(false),
    clear: () => Promise.resolve(),
    size: () => Promise.resolve(items.length),
  };
}

function settings(over: Partial<SagittariusSettings> = {}): SagittariusSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}

describe('gatherDiagnostics', () => {
  it('captures plugin version and retrieval flags', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings({ apiKey: 'sk-x', huggingfaceApiKey: 'hf-x' }),
      activityLog: null,
      suggestionQueue: null,
      engineLoaded: true,
      isIndexing: false,
    });
    expect(snap.pluginVersion).toBe('0.8.1');
    expect(snap.retrieval).toEqual({
      hfTokenSet: true,
      anthropicKeySet: true,
      engineLoaded: true,
      indexing: false,
    });
  });

  it('mirrors organization settings into the snapshot', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings({
        organizationEnabled: true,
        organizationWatchedFolders: ['10-Inbox/', '11-Drafts/'],
        organizationClassifierModel: 'claude-haiku-4-5-20251001',
        organizationMinConfidence: 0.75,
        organizationSweepIntervalSec: 30,
        organizationMocFolders: ['22-Decisions/', '30-GTM/'],
      }),
      activityLog: null,
      suggestionQueue: null,
      engineLoaded: false,
      isIndexing: false,
    });
    expect(snap.organization).toEqual({
      enabled: true,
      watchedFolders: ['10-Inbox/', '11-Drafts/'],
      classifierModel: 'claude-haiku-4-5-20251001',
      minConfidence: 0.75,
      sweepIntervalSec: 30,
      mocFoldersConfigured: 2,
    });
  });

  it('counts activity-log events by kind', async () => {
    const events: ActivityEvent[] = [
      { id: '1', timestamp: 1, kind: 'classifier.ran', notePath: 'a.md', model: 'sonnet', outcome: 'route', confidence: 0.9, durationMs: 100 },
      { id: '2', timestamp: 2, kind: 'classifier.ran', notePath: 'b.md', model: 'sonnet', outcome: 'keep', durationMs: 80 },
      { id: '3', timestamp: 3, kind: 'error', source: 'classifier', message: 'oops' },
      { id: '4', timestamp: 4, kind: 'suggestion.applied', suggestionId: 's1', suggestionKind: 'route', notePath: 'a.md', writeToolName: 'move_note' },
    ];
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings(),
      activityLog: fakeActivityLog([...events]),
      suggestionQueue: null,
      engineLoaded: false,
      isIndexing: false,
    });
    expect(snap.activityLog).not.toBeNull();
    expect(snap.activityLog?.size).toBe(4);
    expect(snap.activityLog?.byKind['classifier.ran']).toBe(2);
    expect(snap.activityLog?.byKind.error).toBe(1);
    expect(snap.activityLog?.byKind['suggestion.applied']).toBe(1);
    expect(snap.activityLog?.byKind['index.built']).toBe(0);
  });

  it('counts suggestion queue by kind and surfaces visible/deferred breakdown', async () => {
    const items: Suggestion[] = [
      { kind: 'route', id: 's1', createdAt: 1, notePath: 'a.md', proposedFolder: 'x', reason: 'r', confidence: 0.9 },
      { kind: 'route', id: 's2', createdAt: 2, notePath: 'b.md', proposedFolder: 'x', reason: 'r', confidence: 0.4 },
      { kind: 'moc-add', id: 's3', createdAt: 3, notePath: 'c.md', mocPath: 'm.md', reason: 'r', confidence: 0.95, deferred: true },
    ];
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings({ organizationMinConfidence: 0.6 }),
      activityLog: null,
      suggestionQueue: fakeQueue(items),
      engineLoaded: false,
      isIndexing: false,
    });
    expect(snap.suggestionQueue).toEqual({
      total: 3,
      visible: 2,
      deferred: 1,
      byKind: { route: 2, mocAdd: 1 },
    });
  });

  it('returns null subsystems when activity log / queue are off', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings(),
      activityLog: null,
      suggestionQueue: null,
      engineLoaded: false,
      isIndexing: false,
    });
    expect(snap.activityLog).toBeNull();
    expect(snap.suggestionQueue).toBeNull();
  });
});

describe('formatDiagnosticsSummary', () => {
  it('compresses snapshot to a one-liner', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings({ organizationEnabled: true }),
      activityLog: fakeActivityLog([]),
      suggestionQueue: fakeQueue([
        { kind: 'route', id: 's1', createdAt: 1, notePath: 'a.md', proposedFolder: 'x', reason: 'r', confidence: 0.9 },
      ]),
      engineLoaded: true,
      isIndexing: false,
    });
    expect(formatDiagnosticsSummary(snap)).toBe('org=on, queue=1, activity=0, index=loaded');
  });

  it('omits queue / activity when subsystems are off', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings(),
      activityLog: null,
      suggestionQueue: null,
      engineLoaded: false,
      isIndexing: false,
    });
    expect(formatDiagnosticsSummary(snap)).toBe('org=off, index=off');
  });
});

describe('formatDiagnosticsReport', () => {
  it('produces a multi-line report with all sections', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings({
        apiKey: 'sk-x',
        huggingfaceApiKey: 'hf-x',
        organizationEnabled: true,
      }),
      activityLog: fakeActivityLog([
        { id: '1', timestamp: 1, kind: 'error', source: 'x', message: 'y' },
      ]),
      suggestionQueue: fakeQueue([]),
      engineLoaded: true,
      isIndexing: false,
    });
    const report = formatDiagnosticsReport(snap);
    expect(report).toContain('Plugin version          0.8.1');
    expect(report).toContain('Retrieval:');
    expect(report).toContain('Anthropic API key     set');
    expect(report).toContain('HuggingFace token     set');
    expect(report).toContain('Engine loaded         yes');
    expect(report).toContain('Organization (Phase 5):');
    expect(report).toContain('Enabled               yes');
    expect(report).toContain('Suggestion queue:');
    expect(report).toContain('Total                 0');
    expect(report).toContain('Activity log (Phase 6):');
    expect(report).toContain('error');
  });

  it('marks off subsystems clearly', async () => {
    const snap = await gatherDiagnostics({
      pluginVersion: '0.8.1',
      settings: settings(),
      activityLog: null,
      suggestionQueue: null,
      engineLoaded: false,
      isIndexing: false,
    });
    const report = formatDiagnosticsReport(snap);
    expect(report).toContain('Suggestion queue:       (engine off)');
    expect(report).toContain('Activity log:           (off)');
    expect(report).toContain('Anthropic API key     MISSING');
  });
});
