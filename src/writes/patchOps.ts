import type { PatchOp } from './types';

/**
 * Pure helper that applies an ordered list of `PatchOp`s to `content`
 * and returns the new content. Validates input shape, rejects overlaps,
 * then applies ops in reverse-position order so earlier positions don't
 * shift under later mutations.
 *
 * Line numbers in `PatchOp` are 1-indexed and inclusive — matches what
 * users see in their editor's line gutter. The implementation converts
 * to 0-indexed array slicing internally.
 *
 * Throws on:
 *   - `replace` / `delete` where `endLine < startLine`
 *   - any op referencing a line number outside [1, lineCount]
 *   - `insert` where `afterLine < 0` or `afterLine > lineCount`
 *   - overlapping ranges across ops (excluding inserts at the same point)
 *
 * @example
 *   const after = applyPatchOps('a\nb\nc\nd', [
 *     { kind: 'replace', startLine: 2, endLine: 2, content: 'B' },
 *     { kind: 'insert', afterLine: 4, content: 'e' },
 *   ]);
 *   // → 'a\nB\nc\nd\ne'
 */
export function applyPatchOps(content: string, ops: PatchOp[]): string {
  const lines = content.split('\n');

  // 1. Validate each op individually.
  for (const op of ops) {
    validateOp(op, lines.length);
  }

  // 2. Reject overlapping ranges. (Inserts touching the same point are
  //    allowed; their concatenation order is determined by stable sort.)
  rejectOverlaps(ops);

  // 3. Sort descending by the position the op AFFECTS, so applying in
  //    order doesn't shift indices for ops that come earlier in the file.
  //    For replace/delete: the position is startLine. For insert:
  //    afterLine (the line the insert happens AFTER, so it's already
  //    fine to compare directly with startLine of other ops).
  const sorted = [...ops].sort((a, b) => positionOf(b) - positionOf(a));

  let working = lines;
  for (const op of sorted) {
    working = applySingleOp(working, op);
  }
  return working.join('\n');
}

function positionOf(op: PatchOp): number {
  return op.kind === 'insert' ? op.afterLine : op.startLine;
}

function validateOp(op: PatchOp, lineCount: number): void {
  if (op.kind === 'insert') {
    if (!Number.isInteger(op.afterLine) || op.afterLine < 0 || op.afterLine > lineCount) {
      throw new Error(
        `applyPatchOps: insert.afterLine must be 0..${lineCount}, got ${op.afterLine}`,
      );
    }
    return;
  }
  if (!Number.isInteger(op.startLine) || op.startLine < 1 || op.startLine > lineCount) {
    throw new Error(
      `applyPatchOps: ${op.kind}.startLine must be 1..${lineCount}, got ${op.startLine}`,
    );
  }
  if (!Number.isInteger(op.endLine) || op.endLine < op.startLine || op.endLine > lineCount) {
    throw new Error(
      `applyPatchOps: ${op.kind}.endLine (${op.endLine}) must be >= startLine (${op.startLine}) ` +
        `and <= lineCount (${lineCount})`,
    );
  }
}

function rejectOverlaps(ops: PatchOp[]): void {
  // Build [start, end] inclusive ranges for each non-insert op (1-indexed).
  // Inserts are point-positioned and only overlap if they target the same
  // line and there's also a replace/delete touching that line — which we
  // catch by checking insert.afterLine against the other op's range.
  const ranges = ops.map((op): [number, number, PatchOp] => {
    if (op.kind === 'insert') {
      return [op.afterLine + 0.5, op.afterLine + 0.5, op];
    }
    return [op.startLine, op.endLine, op];
  });

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const [aStart, aEnd] = ranges[i];
      const [bStart, bEnd] = ranges[j];
      if (aStart <= bEnd && bStart <= aEnd) {
        throw new Error(
          `applyPatchOps: ops #${i} and #${j} have overlapping ranges. ` +
            'Each region of the file can be modified by at most one op per call.',
        );
      }
    }
  }
}

function applySingleOp(lines: string[], op: PatchOp): string[] {
  if (op.kind === 'insert') {
    // afterLine 0 → insert at position 0 (very top).
    // afterLine N → insert after the Nth line (index N-1), so position N.
    const newLines = op.content.split('\n');
    const result = [...lines];
    result.splice(op.afterLine, 0, ...newLines);
    return result;
  }

  // replace / delete: remove the inclusive range [startLine..endLine],
  // optionally inserting new content at the start position.
  const startIdx = op.startLine - 1;
  const removeCount = op.endLine - op.startLine + 1;
  const result = [...lines];

  if (op.kind === 'delete') {
    result.splice(startIdx, removeCount);
    return result;
  }

  // replace
  const newLines = op.content.split('\n');
  result.splice(startIdx, removeCount, ...newLines);
  return result;
}
