import { describe, expect, it } from 'vitest';

import { ExternalProposalQueue } from '../../src/writes/ExternalProposalQueue';
import type { Proposal } from '../../src/writes/types';

function fakeProposal(path = 'note.md'): Proposal {
  return {
    toolName: 'create_note',
    args: { path, content: 'body' },
    diff: { kind: 'create-file', path, content: 'body' },
    apply: () =>
      Promise.resolve({
        toolName: 'create_note',
        path,
        appliedAt: 1,
        inverse: { kind: 'delete-file', path },
      }),
  };
}

describe('ExternalProposalQueue', () => {
  it('enqueue returns a pending promise + makes the entry visible', () => {
    const q = new ExternalProposalQueue({ now: () => 1, randId: () => 'a1' });
    const promise = q.enqueue(fakeProposal(), 'mcp:claude-desktop');
    const entries = q.pending();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('1-a1');
    expect(entries[0].source).toBe('mcp:claude-desktop');
    // Promise stays pending until respond fires.
    expect(promise).toBeInstanceOf(Promise);
  });

  it('respond resolves the matching promise with the supplied decision', async () => {
    const q = new ExternalProposalQueue({ now: () => 1, randId: () => 'a1' });
    const promise = q.enqueue(fakeProposal(), 'mcp:claude-desktop');
    q.respond('1-a1', { kind: 'accept' });
    await expect(promise).resolves.toEqual({ kind: 'accept' });
  });

  it('respond removes the entry from pending()', () => {
    const q = new ExternalProposalQueue({ now: () => 1, randId: () => 'a1' });
    void q.enqueue(fakeProposal(), 'mcp:claude-desktop');
    q.respond('1-a1', { kind: 'reject', reason: 'no' });
    expect(q.pending()).toHaveLength(0);
    expect(q.size()).toBe(0);
  });

  it('respond throws when the id is unknown', () => {
    const q = new ExternalProposalQueue();
    expect(() => q.respond('nope-id', { kind: 'accept' })).toThrow(
      /no pending entry with id 'nope-id'/,
    );
  });

  it('sorts pending() by enqueuedAt ascending', () => {
    let t = 100;
    let n = 0;
    const q = new ExternalProposalQueue({
      now: () => t,
      randId: () => `r${n++}`,
    });
    void q.enqueue(fakeProposal('a.md'), 'mcp:c1');
    t = 50;
    void q.enqueue(fakeProposal('b.md'), 'mcp:c2');
    t = 200;
    void q.enqueue(fakeProposal('c.md'), 'mcp:c3');
    const order = q.pending().map((e) => e.proposal.args.path);
    expect(order).toEqual(['b.md', 'a.md', 'c.md']);
  });

  it('onChange fires on enqueue + respond', () => {
    const q = new ExternalProposalQueue({ now: () => 1, randId: () => 'a1' });
    let calls = 0;
    q.onChange(() => {
      calls += 1;
    });
    void q.enqueue(fakeProposal(), 'mcp:c');
    expect(calls).toBe(1);
    q.respond('1-a1', { kind: 'accept' });
    expect(calls).toBe(2);
  });

  it('onChange returns an unsubscribe that prevents further callbacks', () => {
    const q = new ExternalProposalQueue({ now: () => 1, randId: () => 'a1' });
    let calls = 0;
    const unsub = q.onChange(() => {
      calls += 1;
    });
    void q.enqueue(fakeProposal(), 'mcp:c');
    unsub();
    q.respond('1-a1', { kind: 'accept' });
    expect(calls).toBe(1);
  });

  it('onChange survives a throwing listener', () => {
    const q = new ExternalProposalQueue({ now: () => 1, randId: () => 'a1' });
    let goodCalls = 0;
    q.onChange(() => {
      throw new Error('listener bug');
    });
    q.onChange(() => {
      goodCalls += 1;
    });
    void q.enqueue(fakeProposal(), 'mcp:c');
    expect(goodCalls).toBe(1);
  });

  it('clearAll rejects every pending entry with the supplied reason', async () => {
    let n = 0;
    const q = new ExternalProposalQueue({ now: () => Date.now(), randId: () => `r${n++}` });
    const p1 = q.enqueue(fakeProposal('a.md'), 'mcp:c1');
    const p2 = q.enqueue(fakeProposal('b.md'), 'mcp:c2');
    q.clearAll('plugin unloading');
    await expect(p1).resolves.toEqual({ kind: 'reject', reason: 'plugin unloading' });
    await expect(p2).resolves.toEqual({ kind: 'reject', reason: 'plugin unloading' });
    expect(q.size()).toBe(0);
  });

  it('clearAll on an empty queue is a no-op (no listener fire)', () => {
    const q = new ExternalProposalQueue();
    let calls = 0;
    q.onChange(() => {
      calls += 1;
    });
    q.clearAll('whatever');
    expect(calls).toBe(0);
  });

  it('size + pending stay in sync as entries come and go', () => {
    let n = 0;
    const q = new ExternalProposalQueue({ now: () => Date.now(), randId: () => `r${n++}` });
    expect(q.size()).toBe(0);
    void q.enqueue(fakeProposal('a.md'), 'mcp:c');
    void q.enqueue(fakeProposal('b.md'), 'mcp:c');
    expect(q.size()).toBe(2);
    expect(q.pending()).toHaveLength(2);
    q.respond(q.pending()[0].id, { kind: 'accept' });
    expect(q.size()).toBe(1);
    expect(q.pending()).toHaveLength(1);
  });
});
