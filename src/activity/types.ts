/**
 * Phase 6 (v0.8.0) Activity Stream event types per
 * [ADR-019](../../docs/2026-05-12-adr-019-phase-6-plan.md) D2.
 *
 * Every observable thing Sagittarius does emits one of these into the
 * `ActivityLog`. The 9-kind taxonomy is binding for v0.8.0; future kinds
 * (curator hits, MCP calls) extend the union without breaking JSON
 * persistence — readers just ignore unknown `kind`s and surface them as
 * "(unknown event)" in the view.
 */

/** Discriminator. Adding a new kind requires both the union member below and the literal here. */
export type ActivityEventKind =
  | 'index.built'
  | 'classifier.ran'
  | 'suggestion.enqueued'
  | 'suggestion.applied'
  | 'suggestion.rejected'
  | 'suggestion.skipped'
  | 'write.committed'
  | 'write.undone'
  | 'error';

interface BaseActivityEvent {
  /** Unique id, `${Date.now()}-${random6}` per the SuggestionQueue convention. */
  id: string;
  /** Unix milliseconds; populated by `ActivityLog.record` at insert time. */
  timestamp: number;
  kind: ActivityEventKind;
}

export interface IndexBuiltEvent extends BaseActivityEvent {
  kind: 'index.built';
  notesProcessed: number;
  chunksAdded: number;
  chunksSkipped: number;
  durationMs: number;
}

export interface ClassifierRanEvent extends BaseActivityEvent {
  kind: 'classifier.ran';
  notePath: string;
  /** Model id, e.g. `claude-sonnet-4-6`. */
  model: string;
  /**
   * What the classifier produced. `route` = move suggestion;
   * `keep` = KEEP sentinel (no move proposed); `moc-add` = add-to-MOC
   * suggestion; `null` = classifier returned no suggestion at all
   * (e.g., empty MOC candidate list).
   */
  outcome: 'route' | 'keep' | 'moc-add' | 'null';
  /** Present for `route` / `moc-add` outcomes. */
  confidence?: number;
  durationMs: number;
}

export interface SuggestionEnqueuedEvent extends BaseActivityEvent {
  kind: 'suggestion.enqueued';
  suggestionId: string;
  suggestionKind: 'route' | 'moc-add';
  notePath: string;
  /** `proposedFolder` for route; `mocPath` for moc-add. */
  target: string;
  confidence: number;
}

export interface SuggestionAppliedEvent extends BaseActivityEvent {
  kind: 'suggestion.applied';
  suggestionId: string;
  suggestionKind: 'route' | 'moc-add';
  notePath: string;
  /** Which write tool committed the change (e.g., `move_note`, `link_notes`). */
  writeToolName: string;
}

export interface SuggestionRejectedEvent extends BaseActivityEvent {
  kind: 'suggestion.rejected';
  suggestionId: string;
  notePath: string;
}

export interface SuggestionSkippedEvent extends BaseActivityEvent {
  kind: 'suggestion.skipped';
  suggestionId: string;
  notePath: string;
  /** True when part of a Skip-all bulk op; false for single-row Skip. */
  bulk: boolean;
}

export interface WriteCommittedEvent extends BaseActivityEvent {
  kind: 'write.committed';
  toolName: string;
  path: string;
}

export interface WriteUndoneEvent extends BaseActivityEvent {
  kind: 'write.undone';
  transactionId: string;
}

export interface ErrorEvent extends BaseActivityEvent {
  kind: 'error';
  /** Subsystem that caught the throw (e.g., `watcher`, `classifier`, `write`). */
  source: string;
  message: string;
}

export type ActivityEvent =
  | IndexBuiltEvent
  | ClassifierRanEvent
  | SuggestionEnqueuedEvent
  | SuggestionAppliedEvent
  | SuggestionRejectedEvent
  | SuggestionSkippedEvent
  | WriteCommittedEvent
  | WriteUndoneEvent
  | ErrorEvent;

/**
 * Distributive `Omit` — produces the union of every event variant minus
 * its auto-populated `id` and `timestamp` fields. Callers of
 * `ActivityLog.record` provide one of these; the log fills in the rest.
 */
export type ActivityEventInput = ActivityEvent extends infer E
  ? E extends ActivityEvent
    ? Omit<E, 'id' | 'timestamp'>
    : never
  : never;
