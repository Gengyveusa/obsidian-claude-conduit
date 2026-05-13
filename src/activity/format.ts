import type {
  ActivityEvent,
  ActivityEventKind,
  ClassifierRanEvent,
  DiagnosticEvent,
  ErrorEvent,
  IndexBuiltEvent,
  SuggestionAppliedEvent,
  SuggestionEnqueuedEvent,
  SuggestionRejectedEvent,
  SuggestionSkippedEvent,
  WriteCommittedEvent,
  WriteUndoneEvent,
} from './types';

/**
 * Pure presentation helpers for the activity view. Kept in `src/activity/`
 * (not `src/views/ActivityView.ts`) so they can be unit-tested without
 * pulling in the `obsidian` runtime import that vitest can't resolve.
 */

export const KIND_GLYPHS: Record<ActivityEventKind, string> = {
  'index.built': '⊞ index',
  'classifier.ran': '🧭 classifier',
  'suggestion.enqueued': '＋ suggestion',
  'suggestion.applied': '✓ applied',
  'suggestion.rejected': '✗ rejected',
  'suggestion.skipped': '⊘ skipped',
  'write.committed': '✎ write',
  'write.undone': '↶ undo',
  error: '⚠ error',
  diagnostic: '⊕ diagnostic',
};

/** Compute a one-line human summary for any event. */
export function summarize(event: ActivityEvent): string {
  switch (event.kind) {
    case 'index.built':
      return summarizeIndexBuilt(event);
    case 'classifier.ran':
      return summarizeClassifierRan(event);
    case 'suggestion.enqueued':
      return summarizeSuggestionEnqueued(event);
    case 'suggestion.applied':
      return summarizeSuggestionApplied(event);
    case 'suggestion.rejected':
      return summarizeSuggestionRejected(event);
    case 'suggestion.skipped':
      return summarizeSuggestionSkipped(event);
    case 'write.committed':
      return summarizeWriteCommitted(event);
    case 'write.undone':
      return summarizeWriteUndone(event);
    case 'error':
      return summarizeError(event);
    case 'diagnostic':
      return summarizeDiagnostic(event);
  }
}

function summarizeIndexBuilt(e: IndexBuiltEvent): string {
  return `${e.notesProcessed} notes, ${e.chunksAdded} chunks (${e.durationMs}ms)`;
}

function summarizeClassifierRan(e: ClassifierRanEvent): string {
  const confidence =
    e.confidence !== undefined ? ` (${Math.round(e.confidence * 100)}%)` : '';
  return `${e.outcome}${confidence} — ${e.notePath} via ${e.model}`;
}

function summarizeSuggestionEnqueued(e: SuggestionEnqueuedEvent): string {
  const arrow = e.suggestionKind === 'route' ? '→' : '+→';
  return `${e.suggestionKind} ${e.notePath} ${arrow} ${e.target} (${Math.round(
    e.confidence * 100,
  )}%)`;
}

function summarizeSuggestionApplied(e: SuggestionAppliedEvent): string {
  return `${e.writeToolName} — ${e.notePath}`;
}

function summarizeSuggestionRejected(e: SuggestionRejectedEvent): string {
  return `${e.notePath}`;
}

function summarizeSuggestionSkipped(e: SuggestionSkippedEvent): string {
  const scope = e.bulk ? 'bulk' : 'single';
  return `${scope} — ${e.notePath}`;
}

function summarizeWriteCommitted(e: WriteCommittedEvent): string {
  return `${e.toolName} — ${e.path}`;
}

function summarizeWriteUndone(e: WriteUndoneEvent): string {
  return `transaction ${e.transactionId}`;
}

function summarizeError(e: ErrorEvent): string {
  return `${e.source} — ${e.message}`;
}

function summarizeDiagnostic(e: DiagnosticEvent): string {
  return e.summary;
}

/** Return the note/file path associated with an event, or null. */
export function pathOf(event: ActivityEvent): string | null {
  switch (event.kind) {
    case 'classifier.ran':
    case 'suggestion.enqueued':
    case 'suggestion.applied':
    case 'suggestion.rejected':
    case 'suggestion.skipped':
      return event.notePath;
    case 'write.committed':
      return event.path;
    case 'index.built':
    case 'write.undone':
    case 'error':
    case 'diagnostic':
      return null;
  }
}

/** Compact relative timestamp like "5m ago" / "2h ago". */
export function formatRelative(eventMs: number, nowMs: number): string {
  const deltaSec = Math.max(0, Math.floor((nowMs - eventMs) / 1000));
  if (deltaSec < 60) {
    return `${deltaSec}s ago`;
  }
  if (deltaSec < 60 * 60) {
    return `${Math.floor(deltaSec / 60)}m ago`;
  }
  if (deltaSec < 60 * 60 * 24) {
    return `${Math.floor(deltaSec / 3600)}h ago`;
  }
  const days = Math.floor(deltaSec / 86400);
  return `${days}d ago`;
}
