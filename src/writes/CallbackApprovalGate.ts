import type { ApprovalGate } from './ApprovalGate';
import type { ExternalProposalQueue } from './ExternalProposalQueue';
import type { WriteToolContext } from './WriteToolContext';
import type { Decision, Proposal } from './types';

/**
 * Production-side `ApprovalGate` that routes each proposal to the
 * right approval surface:
 *
 *   - **In-app chat proposals** (`ctx.currentSource() === undefined`):
 *     delegate to the UI callback `ChatView` registers when it opens.
 *     When no callback is set (panel closed, BRAT updating), auto-reject
 *     so the LLM gets actionable feedback instead of hanging.
 *
 *   - **External MCP proposals** (`ctx.currentSource() === 'mcp:<client>'`):
 *     enqueue into the `ExternalProposalQueue` per ADR-025 D2 (c) +
 *     D4 (b). The side panel resolves them when the user clicks
 *     Approve/Reject; meanwhile the queue lets McpHandler's 30s
 *     timeout race against it for the "block-then-queue" semantics.
 *     When the queue isn't wired (test fixtures, or plugin built
 *     without write-side), falls back to auto-reject.
 *
 * Both deps optional so test fixtures and Phase 6.5-era callers keep
 * working unchanged: omit them and the gate behaves exactly like v0.9.x.
 *
 * @example
 *   const gate = new CallbackApprovalGate({ ctx, externalQueue });
 *   gate.set((p) => chatView.requestApproval(p));   // when ChatView opens
 *   gate.set(null);                                   // when it closes
 */
export interface CallbackApprovalGateDeps {
  /**
   * `WriteToolContext` whose `currentSource()` is read to decide
   * whether a proposal is in-app or external. Omit to disable routing
   * (every proposal goes to the in-app callback path).
   */
  ctx?: WriteToolContext;
  /**
   * The queue MCP-driven proposals are enqueued onto. Omit and
   * external proposals auto-reject (back-compat with v1.0.9-era
   * "in-app chat in progress, retry shortly").
   */
  externalQueue?: ExternalProposalQueue;
}

export class CallbackApprovalGate implements ApprovalGate {
  private callback: ((proposal: Proposal) => Promise<Decision>) | null = null;
  private ctx: WriteToolContext | undefined;
  private externalQueue: ExternalProposalQueue | undefined;

  constructor(deps: CallbackApprovalGateDeps = {}) {
    this.ctx = deps.ctx;
    this.externalQueue = deps.externalQueue;
  }

  /** Install (or clear) the active UI callback. */
  set(callback: ((proposal: Proposal) => Promise<Decision>) | null): void {
    this.callback = callback;
  }

  /**
   * Phase 6.7 (v1.1.0) — late-bind the routing deps. The plugin
   * constructs the gate at class-instantiation time (before settings
   * load) but the `WriteToolContext` only exists after `buildAgent()`
   * runs; this seam lets `main.ts` wire the queue + ctx once both
   * are available. Safe to call repeatedly (e.g. on agent rebuild).
   */
  setRoutingDeps(deps: CallbackApprovalGateDeps): void {
    if (deps.ctx !== undefined) {
      this.ctx = deps.ctx;
    }
    if (deps.externalQueue !== undefined) {
      this.externalQueue = deps.externalQueue;
    }
  }

  request(proposal: Proposal): Promise<Decision> {
    const source = this.ctx?.currentSource();
    if (source !== undefined) {
      // External / MCP proposal — route to the queue if wired.
      if (this.externalQueue === undefined) {
        return Promise.resolve<Decision>({
          kind: 'reject',
          reason:
            `External proposal from '${source}' but no proposal queue is wired. ` +
            'This is a configuration bug — wire ExternalProposalQueue when constructing CallbackApprovalGate.',
        });
      }
      return this.externalQueue.enqueue(proposal, source);
    }
    if (this.callback === null) {
      return Promise.resolve<Decision>({
        kind: 'reject',
        reason:
          'No chat panel is open to approve this write. Open Sagittarius (sidebar → chat icon) and ask again.',
      });
    }
    return this.callback(proposal);
  }
}
