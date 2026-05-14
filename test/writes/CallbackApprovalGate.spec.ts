import { describe, expect, it } from 'vitest';

import { CallbackApprovalGate } from '../../src/writes/CallbackApprovalGate';
import { ExternalProposalQueue } from '../../src/writes/ExternalProposalQueue';
import type { WriteToolContext } from '../../src/writes/WriteToolContext';
import type { AppliedOp, Proposal } from '../../src/writes/types';

/**
 * Lightweight stub — the routing path only reads `currentSource()`.
 * Wiring a real `WriteToolContext` would require a `TransactionLog`
 * + `VaultAdapter` for no behavioral gain.
 */
function stubCtx(source: string | undefined): WriteToolContext {
  return { currentSource: () => source } as unknown as WriteToolContext;
}

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

describe('CallbackApprovalGate routing (ADR-025 D4)', () => {
  it('routes to the external queue when ctx.currentSource() is set', async () => {
    const queue = new ExternalProposalQueue({ now: () => 7, randId: () => 'abc' });
    const gate = new CallbackApprovalGate({
      ctx: stubCtx('mcp:claude-desktop'),
      externalQueue: queue,
    });
    // Callback would NOT be called for an external proposal — set one to
    // prove it doesn't fire.
    let callbackCalls = 0;
    gate.set(() => {
      callbackCalls += 1;
      return Promise.resolve({ kind: 'accept' });
    });
    const promise = gate.request(makeProposal());
    expect(queue.pending()).toHaveLength(1);
    expect(queue.pending()[0].source).toBe('mcp:claude-desktop');
    expect(callbackCalls).toBe(0);

    queue.respond(queue.pending()[0].id, { kind: 'accept' });
    await expect(promise).resolves.toEqual({ kind: 'accept' });
  });

  it('routes to the callback when ctx.currentSource() is undefined (in-app chat)', async () => {
    const queue = new ExternalProposalQueue();
    const gate = new CallbackApprovalGate({ ctx: stubCtx(undefined), externalQueue: queue });
    let seen = false;
    gate.set(() => {
      seen = true;
      return Promise.resolve({ kind: 'accept' });
    });
    const d = await gate.request(makeProposal());
    expect(seen).toBe(true);
    expect(d).toEqual({ kind: 'accept' });
    expect(queue.size()).toBe(0);
  });

  it('auto-rejects an external proposal when the queue is not wired (defensive)', async () => {
    const gate = new CallbackApprovalGate({ ctx: stubCtx('mcp:test-bot') });
    const d = await gate.request(makeProposal());
    expect(d.kind).toBe('reject');
    expect(d.kind === 'reject' && d.reason).toMatch(/no proposal queue is wired/);
  });

  it('falls back to v0.9.x behavior (in-app auto-reject) when neither dep is supplied', async () => {
    const gate = new CallbackApprovalGate();
    const d = await gate.request(makeProposal());
    expect(d.kind).toBe('reject');
    expect(d.kind === 'reject' && d.reason).toMatch(/No chat panel/);
  });

  it('the external-routing path bypasses the installed callback entirely', async () => {
    const queue = new ExternalProposalQueue();
    const gate = new CallbackApprovalGate({
      ctx: stubCtx('mcp:writer-bot'),
      externalQueue: queue,
    });
    gate.set(() => Promise.reject(new Error('callback should never fire')));
    const promise = gate.request(makeProposal());
    // If the callback had been called, the awaited gate.request would
    // reject. Resolve via queue instead.
    queue.respond(queue.pending()[0].id, { kind: 'accept' });
    await expect(promise).resolves.toEqual({ kind: 'accept' });
  });
});
