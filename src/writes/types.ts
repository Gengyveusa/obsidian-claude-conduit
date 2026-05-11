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

/**
 * Proposed change emitted by a write tool *before* it actually applies.
 * Per ADR-016 D2, the agent loop hands every proposal to the
 * `ApprovalGate` and only runs `apply()` if the user accepts.
 *
 * The closure-on-proposal shape captures everything the tool needs to
 * commit, including any captured state (file mtimes, hashes, etc) — see
 * `apply` below.
 */
export interface Proposal {
  /** Tool that produced this proposal. */
  toolName: string;
  /** Tool args as the LLM passed them. Rendered as JSON in the diff card. */
  args: Record<string, unknown>;
  /** Structured description of the change. Renderer formats into a unified diff. */
  diff: ProposalDiff;
  /**
   * Execute the write. Called only after the user accepts. Returns the
   * `AppliedOp` to record in the transaction log. Should be called at
   * most once per proposal — re-applying after a successful apply is a
   * logic bug (the tool's captured state may be stale).
   */
  apply: () => Promise<AppliedOp>;
}

/**
 * What a proposal will do, in renderer-ready form. v0.3.0 ships two
 * variants matched to the first two write tools; later PRs extend.
 */
export type ProposalDiff =
  | {
      kind: 'create-file';
      path: string;
      content: string;
    }
  | {
      kind: 'append-to-file';
      path: string;
      /** Last few lines of the existing file, for context in the diff card. */
      existingTail: string;
      /** Lines being appended. */
      appendedContent: string;
    };

/**
 * The user's response to a proposal. Returned by the `ApprovalGate`.
 *
 * `accept` → run `proposal.apply()` + record in transaction log.
 * `reject` → skip apply; surface `reason` to the agent so the LLM can revise.
 */
export type Decision =
  | { kind: 'accept' }
  | { kind: 'reject'; reason?: string };
