import { describe, expect, it } from 'vitest';

import { applyPatchOps } from '../../src/writes/patchOps';
import type { PatchOp } from '../../src/writes/types';

describe('applyPatchOps — single-op cases', () => {
  it('replaces a single line', () => {
    expect(
      applyPatchOps('a\nb\nc', [{ kind: 'replace', startLine: 2, endLine: 2, content: 'B' }]),
    ).toBe('a\nB\nc');
  });

  it('replaces a range with multi-line content', () => {
    expect(
      applyPatchOps('a\nb\nc\nd', [
        { kind: 'replace', startLine: 2, endLine: 3, content: 'X\nY\nZ' },
      ]),
    ).toBe('a\nX\nY\nZ\nd');
  });

  it('deletes a single line', () => {
    expect(applyPatchOps('a\nb\nc', [{ kind: 'delete', startLine: 2, endLine: 2 }])).toBe(
      'a\nc',
    );
  });

  it('deletes a range', () => {
    expect(
      applyPatchOps('a\nb\nc\nd\ne', [{ kind: 'delete', startLine: 2, endLine: 4 }]),
    ).toBe('a\ne');
  });

  it('inserts after a given line', () => {
    expect(
      applyPatchOps('a\nb\nc', [{ kind: 'insert', afterLine: 1, content: 'A.5' }]),
    ).toBe('a\nA.5\nb\nc');
  });

  it('inserts at the top with afterLine 0', () => {
    expect(
      applyPatchOps('a\nb', [{ kind: 'insert', afterLine: 0, content: 'header' }]),
    ).toBe('header\na\nb');
  });

  it('inserts at the bottom with afterLine === lineCount', () => {
    expect(
      applyPatchOps('a\nb', [{ kind: 'insert', afterLine: 2, content: 'footer' }]),
    ).toBe('a\nb\nfooter');
  });

  it('inserts multi-line content', () => {
    expect(
      applyPatchOps('a\nb', [{ kind: 'insert', afterLine: 1, content: 'x\ny' }]),
    ).toBe('a\nx\ny\nb');
  });
});

describe('applyPatchOps — multi-op cases (positions describe the ORIGINAL file)', () => {
  it('applies non-overlapping ops in reverse position order', () => {
    // Original lines (1-indexed): 1:a 2:b 3:c 4:d
    // Op 1: replace line 2 with B
    // Op 2: insert after line 4 with e
    // Expected: a B c d e
    expect(
      applyPatchOps('a\nb\nc\nd', [
        { kind: 'replace', startLine: 2, endLine: 2, content: 'B' },
        { kind: 'insert', afterLine: 4, content: 'e' },
      ]),
    ).toBe('a\nB\nc\nd\ne');
  });

  it('handles ops provided in non-sorted order', () => {
    // Same ops, swapped input order — output must be identical.
    expect(
      applyPatchOps('a\nb\nc\nd', [
        { kind: 'insert', afterLine: 4, content: 'e' },
        { kind: 'replace', startLine: 2, endLine: 2, content: 'B' },
      ]),
    ).toBe('a\nB\nc\nd\ne');
  });

  it('combines delete + replace + insert without shifting indices', () => {
    // Original: 1:a 2:b 3:c 4:d 5:e
    // Op A: replace 1 with A
    // Op B: delete 3
    // Op C: insert after 5 with f
    // Result: A b d e f
    expect(
      applyPatchOps('a\nb\nc\nd\ne', [
        { kind: 'replace', startLine: 1, endLine: 1, content: 'A' },
        { kind: 'delete', startLine: 3, endLine: 3 },
        { kind: 'insert', afterLine: 5, content: 'f' },
      ]),
    ).toBe('A\nb\nd\ne\nf');
  });

  it('returns input unchanged when ops list is empty', () => {
    expect(applyPatchOps('a\nb\nc', [])).toBe('a\nb\nc');
  });
});

describe('applyPatchOps — validation', () => {
  const c = 'a\nb\nc\nd';

  it('rejects replace.startLine < 1', () => {
    expect(() =>
      applyPatchOps(c, [{ kind: 'replace', startLine: 0, endLine: 1, content: 'X' }]),
    ).toThrow(/startLine must be/);
  });

  it('rejects replace.startLine > lineCount', () => {
    expect(() =>
      applyPatchOps(c, [{ kind: 'replace', startLine: 99, endLine: 99, content: 'X' }]),
    ).toThrow(/startLine must be/);
  });

  it('rejects replace.endLine < startLine', () => {
    expect(() =>
      applyPatchOps(c, [{ kind: 'replace', startLine: 3, endLine: 2, content: 'X' }]),
    ).toThrow(/endLine .* >= startLine/);
  });

  it('rejects replace.endLine > lineCount', () => {
    expect(() =>
      applyPatchOps(c, [{ kind: 'replace', startLine: 2, endLine: 99, content: 'X' }]),
    ).toThrow(/endLine .* lineCount/);
  });

  it('rejects insert.afterLine < 0', () => {
    expect(() => applyPatchOps(c, [{ kind: 'insert', afterLine: -1, content: 'X' }])).toThrow(
      /afterLine must be/,
    );
  });

  it('rejects insert.afterLine > lineCount', () => {
    expect(() => applyPatchOps(c, [{ kind: 'insert', afterLine: 99, content: 'X' }])).toThrow(
      /afterLine must be/,
    );
  });

  it('rejects non-integer line numbers', () => {
    expect(() =>
      applyPatchOps(c, [{ kind: 'replace', startLine: 1.5, endLine: 2, content: 'X' }]),
    ).toThrow(/startLine/);
  });

  describe('overlap detection', () => {
    it('rejects two replaces hitting the same line', () => {
      const ops: PatchOp[] = [
        { kind: 'replace', startLine: 2, endLine: 2, content: 'A' },
        { kind: 'replace', startLine: 2, endLine: 2, content: 'B' },
      ];
      expect(() => applyPatchOps(c, ops)).toThrow(/overlapping ranges/);
    });

    it('rejects replace + delete on overlapping ranges', () => {
      const ops: PatchOp[] = [
        { kind: 'replace', startLine: 2, endLine: 3, content: 'X' },
        { kind: 'delete', startLine: 3, endLine: 4 },
      ];
      expect(() => applyPatchOps(c, ops)).toThrow(/overlapping ranges/);
    });

    it('rejects an insert whose afterLine falls inside a replace range', () => {
      const ops: PatchOp[] = [
        { kind: 'replace', startLine: 2, endLine: 4, content: 'X' },
        { kind: 'insert', afterLine: 3, content: 'mid' },
      ];
      expect(() => applyPatchOps(c, ops)).toThrow(/overlapping ranges/);
    });

    it('allows adjacent (non-overlapping) ranges', () => {
      const ops: PatchOp[] = [
        { kind: 'replace', startLine: 1, endLine: 2, content: 'X' },
        { kind: 'replace', startLine: 3, endLine: 4, content: 'Y' },
      ];
      expect(applyPatchOps(c, ops)).toBe('X\nY');
    });
  });
});
