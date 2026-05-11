import type { ApprovalGate } from './ApprovalGate';
import type { Decision, Proposal } from './types';

/**
 * Production-side `ApprovalGate` that delegates each proposal to a
 * callback set by whatever UI is currently capable of showing a diff
 * card. In Sagittarius v0.3.0 that's `ChatView` — it registers its
 * `requestApproval` method when the side panel opens, and clears it
 * when the panel closes.
 *
 * When no callback is set (chat panel closed, BRAT updating, etc), the
 * gate auto-rejects with a clear reason so the LLM gets actionable
 * feedback instead of hanging on a Promise that never resolves.
 *
 * @example
 *   const gate = new CallbackApprovalGate();
 *   // ... later, when ChatView opens:
 *   gate.set((p) => chatView.requestApproval(p));
 *   // ... when it closes:
 *   gate.set(null);
 */
export class CallbackApprovalGate implements ApprovalGate {
  private callback: ((proposal: Proposal) => Promise<Decision>) | null = null;

  /** Install (or clear) the active UI callback. */
  set(callback: ((proposal: Proposal) => Promise<Decision>) | null): void {
    this.callback = callback;
  }

  request(proposal: Proposal): Promise<Decision> {
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
