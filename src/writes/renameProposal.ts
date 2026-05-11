import type { VaultAdapter } from '../agent/types';

import type { ApprovalGate } from './ApprovalGate';
import type { AppliedOp, Proposal } from './types';
import type { WriteToolContext } from './WriteToolContext';

/**
 * Shared proposal builder for `move_note` and `rename_note`. Both tools
 * reduce to the same underlying op (move the file at `fromPath` to
 * `toPath`); only their tool-input surface differs.
 *
 * Validations performed BEFORE proposing (so the LLM gets fast feedback):
 *   - `fromPath` exists
 *   - `toPath` does not exist (no clobber)
 *   - `fromPath !== toPath` (would be a silent no-op)
 *
 * The propose-then-apply pattern matches v0.3.x tools. Inverse op
 * `{ kind: 'rename-file', from: toPath, to: fromPath }` undoes the move.
 *
 * We don't take `expectedMtime` / `expectedHash` — moves don't read body
 * content, so a stale-view check would be over-strict. If `fromPath` was
 * moved or deleted between the LLM's read_note and this tool's
 * invocation, the exists() check above surfaces it.
 */
export interface RenameProposalDeps {
  adapter: VaultAdapter;
  gate: ApprovalGate;
  ctx: WriteToolContext;
  now?: () => number;
}

export interface RenameProposalResult {
  status: 'applied' | 'rejected' | 'error';
  fromPath: string;
  toPath: string;
  reason?: string;
  error?: string;
}

export async function runRenameProposal(
  deps: RenameProposalDeps,
  toolName: 'move_note' | 'rename_note',
  fromPath: string,
  toPath: string,
  extraArgs: Record<string, unknown> = {},
): Promise<RenameProposalResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  if (fromPath === toPath) {
    return {
      status: 'error',
      fromPath,
      toPath,
      error: 'fromPath and toPath are identical — nothing to do.',
    };
  }
  if (!(await deps.adapter.exists(fromPath))) {
    return {
      status: 'error',
      fromPath,
      toPath,
      error: `Source file does not exist: ${fromPath}.`,
    };
  }
  if (await deps.adapter.exists(toPath)) {
    return {
      status: 'error',
      fromPath,
      toPath,
      error: `Destination already exists: ${toPath}. Refusing to clobber.`,
    };
  }

  const proposal: Proposal = {
    toolName,
    args: { fromPath, toPath, ...extraArgs },
    diff: { kind: 'rename-file', fromPath, toPath },
    apply: async (): Promise<AppliedOp> => {
      await deps.adapter.renameFile(fromPath, toPath);
      return {
        toolName,
        path: toPath, // primary path AFTER apply
        appliedAt: now(),
        inverse: { kind: 'rename-file', from: toPath, to: fromPath },
      };
    },
  };

  const decision = await deps.gate.request(proposal);
  if (decision.kind === 'reject') {
    const result: RenameProposalResult = { status: 'rejected', fromPath, toPath };
    if (decision.reason !== undefined) {
      result.reason = decision.reason;
    }
    return result;
  }

  const appliedOp = await proposal.apply();
  deps.ctx.record(appliedOp);
  return { status: 'applied', fromPath, toPath };
}
