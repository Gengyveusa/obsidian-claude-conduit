/**
 * Phase 4 write-layer types per ADR-016.
 *
 * `Transaction` groups all approved write ops from a single agent turn
 * (D3: per-tool atomicity, per-turn undo unit). The transaction log
 * stores them in append-only JSON for the eventual `undo` command (v0.5.0
 * PR 11 per ADR-016 D5).
 *
 * `InverseOp` is what's needed to revert one applied op — the *minimum*
 * data the undo replay needs. For v0.3.0 we only need the two variants
 * exercised by `create_note` (delete the created file) and
 * `append_to_note` (restore the prior content). Later phases extend.
 */

export interface Transaction {
  /** Monotonic, sortable id: `${epochMs}-${rand6}`. */
  id: string;
  /** Epoch seconds when the first op committed. */
  timestamp: number;
  /** Optional chat-session id that owned this turn. */
  sessionId?: string;
  /** Ops in apply order. Undo replays inverse in reverse order. */
  ops: AppliedOp[];
}

export interface AppliedOp {
  /** Tool that produced this op — `'create_note'`, `'append_to_note'`, etc. */
  toolName: string;
  /** Primary target path (vault-relative). */
  path: string;
  /** Epoch seconds when the op applied. */
  appliedAt: number;
  /** What to do to revert this op. */
  inverse: InverseOp;
}

/**
 * Discriminated union of all undo strategies. v0.3.0 ships two; later
 * write tools extend this. Each variant is self-contained — the undo
 * replayer dispatches on `kind` and applies the right adapter call.
 */
export type InverseOp =
  /** Delete `path`. Inverse of `create_note`. */
  | { kind: 'delete-file'; path: string }
  /** Write `content` to `path` (overwriting). Inverse of `append_to_note` (or any other op that modified an existing file's body). */
  | { kind: 'write-file'; path: string; content: string };
