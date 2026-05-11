import { describe, expect, it } from 'vitest';

import { CallbackApprovalGate } from '../../src/writes/CallbackApprovalGate';
import type { AppliedOp, Proposal } from '../../src/writes/types';

function makeProposal(): Proposal {
  return {
    toolName: 'create_note',
    args: { path: 'a.md' },
    diff: { kind: 'create-file', path: 'a.md', content: 'x' },
    apply: () =>
      Promise.resolve<AppliedOp>({
        toolName: 'create_note',
        path: 'a.md',
        appliedAt: 0,
        inverse: { kind: 'delete-file', path: 'a.md' },
      }),
  };
}

describe('CallbackApprovalGate', () => {
  it('rejects with a helpful reason when no callback is set', async () => {
    const gate = new CallbackApprovalGate();
    const d = await gate.request(makeProposal());
    expect(d.kind).toBe('reject');
    expect(d.kind === 'reject' && d.reason).toMatch(/No chat panel/);
  });

  it('delegates to the installed callback', async () => {
    const gate = new CallbackApprovalGate();
    gate.set(() => Promise.resolve({ kind: 'accept' }));
    const d = await gate.request(makeProposal());
    expect(d).toEqual({ kind: 'accept' });
  });

  it('respects the latest set() call', async () => {
    const gate = new CallbackApprovalGate();
    gate.set(() => Promise.resolve({ kind: 'accept' }));
    gate.set(() => Promise.resolve({ kind: 'reject', reason: 'overridden' }));
    const d = await gate.request(makeProposal());
    expect(d).toEqual({ kind: 'reject', reason: 'overridden' });
  });

  it('reverts to auto-reject when the callback is cleared', async () => {
    const gate = new CallbackApprovalGate();
    gate.set(() => Promise.resolve({ kind: 'accept' }));
    gate.set(null);
    const d = await gate.request(makeProposal());
    expect(d.kind).toBe('reject');
  });

  it('passes the proposal through unchanged', async () => {
    const gate = new CallbackApprovalGate();
    let seen: Proposal | null = null;
    gate.set((p) => {
      seen = p;
      return Promise.resolve({ kind: 'accept' });
    });
    const proposal = makeProposal();
    await gate.request(proposal);
    expect(seen).toBe(proposal);
  });
});
