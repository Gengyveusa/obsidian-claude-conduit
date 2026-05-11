import type { Decision, Proposal } from './types';

/**
 * Per ADR-016 D2, every write tool routes its proposal through an
 * `ApprovalGate` before any side effects. The production gate (wired
 * in PR 4 alongside the first tools) blocks on a UI accept/reject
 * click. Tests inject one of the fakes below.
 *
 * The gate sees the proposal but not the apply closure — it just
 * returns a decision. The agent loop is responsible for running
 * `proposal.apply()` on accept and surfacing the reject reason to the
 * LLM otherwise.
 */
export interface ApprovalGate {
  request(proposal: Proposal): Promise<Decision>;
}

/** Test fake — always accepts. Lets unit tests exercise the apply path. */
export class AcceptAllGate implements ApprovalGate {
  /** Proposals seen, in call order. Useful for assertions. */
  readonly seen: Proposal[] = [];

  request(proposal: Proposal): Promise<Decision> {
    this.seen.push(proposal);
    return Promise.resolve({ kind: 'accept' });
  }
}

/** Test fake — always rejects. Lets unit tests exercise the reject path. */
export class RejectAllGate implements ApprovalGate {
  readonly seen: Proposal[] = [];

  constructor(private readonly reason: string = 'test fake rejected') {}

  request(proposal: Proposal): Promise<Decision> {
    this.seen.push(proposal);
    return Promise.resolve({ kind: 'reject', reason: this.reason });
  }
}

/**
 * Test fake — returns decisions from a pre-seeded queue. Useful when a
 * test simulates a sequence (accept first, reject second, accept third).
 * Throws if the queue is exhausted, so tests can't accidentally rely on
 * an undocumented default.
 *
 * @example
 *   const gate = new ScriptedGate([
 *     { kind: 'accept' },
 *     { kind: 'reject', reason: 'changed my mind' },
 *   ]);
 *   await agent.run(...);  // pulls decisions in order
 */
export class ScriptedGate implements ApprovalGate {
  readonly seen: Proposal[] = [];
  private readonly queue: Decision[];

  constructor(decisions: Decision[]) {
    this.queue = [...decisions];
  }

  request(proposal: Proposal): Promise<Decision> {
    this.seen.push(proposal);
    const next = this.queue.shift();
    if (next === undefined) {
      // Reject (not synchronous throw) so callers can `.rejects.toThrow()` uniformly.
      return Promise.reject(
        new Error(
          `ScriptedGate exhausted: proposal #${this.seen.length} (${proposal.toolName}) ` +
            `arrived but no scripted decision remains. Seed more decisions.`,
        ),
      );
    }
    return Promise.resolve(next);
  }
}
