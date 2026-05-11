import { describe, expect, it } from 'vitest';

import {
  AcceptAllGate,
  RejectAllGate,
  ScriptedGate,
} from '../../src/writes/ApprovalGate';
import type { AppliedOp, Proposal } from '../../src/writes/types';

function makeProposal(toolName: string, path: string): Proposal {
  return {
    toolName,
    args: { path },
    diff: { kind: 'create-file', path, content: 'hi' },
    apply: () =>
      Promise.resolve<AppliedOp>({
        toolName,
        path,
        appliedAt: 1700000000,
        inverse: { kind: 'delete-file', path },
      }),
  };
}

describe('AcceptAllGate', () => {
  it('returns accept for every proposal', async () => {
    const gate = new AcceptAllGate();
    const d1 = await gate.request(makeProposal('create_note', 'a.md'));
    const d2 = await gate.request(makeProposal('create_note', 'b.md'));
    expect(d1).toEqual({ kind: 'accept' });
    expect(d2).toEqual({ kind: 'accept' });
  });

  it('records every proposal seen in call order', async () => {
    const gate = new AcceptAllGate();
    await gate.request(makeProposal('create_note', 'a.md'));
    await gate.request(makeProposal('append_to_note', 'b.md'));
    expect(gate.seen.map((p) => p.toolName)).toEqual(['create_note', 'append_to_note']);
  });
});

describe('RejectAllGate', () => {
  it('returns reject with default reason for every proposal', async () => {
    const gate = new RejectAllGate();
    const d = await gate.request(makeProposal('create_note', 'a.md'));
    expect(d).toEqual({ kind: 'reject', reason: 'test fake rejected' });
  });

  it('supports a custom reason', async () => {
    const gate = new RejectAllGate('user closed chat');
    const d = await gate.request(makeProposal('create_note', 'a.md'));
    expect(d).toEqual({ kind: 'reject', reason: 'user closed chat' });
  });

  it('records every proposal seen', async () => {
    const gate = new RejectAllGate();
    await gate.request(makeProposal('create_note', 'a.md'));
    await gate.request(makeProposal('create_note', 'b.md'));
    expect(gate.seen).toHaveLength(2);
  });
});

describe('ScriptedGate', () => {
  it('returns scripted decisions in order', async () => {
    const gate = new ScriptedGate([
      { kind: 'accept' },
      { kind: 'reject', reason: 'changed mind' },
      { kind: 'accept' },
    ]);
    expect(await gate.request(makeProposal('create_note', 'a.md'))).toEqual({
      kind: 'accept',
    });
    expect(await gate.request(makeProposal('create_note', 'b.md'))).toEqual({
      kind: 'reject',
      reason: 'changed mind',
    });
    expect(await gate.request(makeProposal('create_note', 'c.md'))).toEqual({
      kind: 'accept',
    });
  });

  it('throws when the queue is exhausted', async () => {
    const gate = new ScriptedGate([{ kind: 'accept' }]);
    await gate.request(makeProposal('create_note', 'a.md'));
    await expect(gate.request(makeProposal('create_note', 'b.md'))).rejects.toThrow(
      /ScriptedGate exhausted/,
    );
  });

  it('does not mutate the seed array', async () => {
    const seed = [{ kind: 'accept' as const }, { kind: 'accept' as const }];
    const gate = new ScriptedGate(seed);
    await gate.request(makeProposal('create_note', 'a.md'));
    await gate.request(makeProposal('create_note', 'b.md'));
    expect(seed).toHaveLength(2);
  });

  it('records every proposal seen even when exhausted', async () => {
    const gate = new ScriptedGate([{ kind: 'accept' }]);
    await gate.request(makeProposal('create_note', 'a.md'));
    try {
      await gate.request(makeProposal('create_note', 'b.md'));
    } catch {
      /* expected */
    }
    expect(gate.seen.map((p) => p.args.path)).toEqual(['a.md', 'b.md']);
  });
});
