/**
 * Phase 5 (Organization Engine) types per [ADR-017](../../docs/2026-05-11-adr-017-phase-5-plan.md).
 *
 * A `Suggestion` is one proactive recommendation the agent surfaces in
 * the suggestions panel. v0.6.0 ships two variants per ADR-017 D3:
 *
 *   - `route`   — move a note (typically from `10-Inbox/`) to a more
 *                 permanent folder. Apply runs through `move_note`.
 *   - `moc-add` — append a `[[wikilink]]` reference to the note inside
 *                 a specific Map-of-Content note. Apply runs through
 *                 `link_notes`.
 *
 * Later versions extend with `frontmatter-suggest`, `moc-create`, etc.
 * (per the v0.7.0 slice in ADR-017 D6).
 *
 * Every Suggestion carries:
 *   - `id`         — sortable epoch-ms id used by Apply/Skip/Defer to refer back
 *   - `createdAt`  — when the classifier produced the suggestion (epoch seconds)
 *   - `confidence` — 0..1 from the classifier; the queue filters on this
 *   - `reason`     — human-readable explanation rendered in the panel row
 *   - `deferred`   — true when the user clicked Defer; sorts to bottom of list
 */

export type Suggestion =
  | RouteSuggestion
  | MocAddSuggestion;

export interface RouteSuggestion {
  kind: 'route';
  id: string;
  createdAt: number;
  /** The note we're proposing to move. */
  notePath: string;
  /** Vault-relative folder we propose moving it to (no trailing slash). */
  proposedFolder: string;
  /** Plain-English explanation for the panel row. */
  reason: string;
  /** Classifier confidence 0..1. */
  confidence: number;
  /** True if the user clicked Defer; sorts to the bottom of the list. */
  deferred?: boolean;
}

export interface MocAddSuggestion {
  kind: 'moc-add';
  id: string;
  createdAt: number;
  /** The note we're proposing to add to a MOC. */
  notePath: string;
  /** Path of the existing MOC we propose adding the note to. */
  mocPath: string;
  /**
   * Optional anchor inside the MOC where the wikilink should land. If
   * omitted, append at end (matches `link_notes`'s default behavior).
   */
  mocAnchor?: string;
  reason: string;
  confidence: number;
  deferred?: boolean;
}
