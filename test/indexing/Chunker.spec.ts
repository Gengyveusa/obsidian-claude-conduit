import { describe, expect, it } from 'vitest';

import { chunk, DEFAULT_CHUNKER_OPTIONS } from '../../src/indexing/Chunker';
import { CHUNKER_MAX_CHARS, CHUNKER_OVERLAP } from '../../src/retrieval/SqliteEngine';

describe('Chunker', () => {
  it('returns [] for empty input', () => {
    expect(chunk('')).toEqual([]);
    expect(chunk('   \n\n   ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const out = chunk('A short paragraph.');
    expect(out).toEqual(['A short paragraph.']);
  });

  it('joins multiple short paragraphs into one chunk under the cap', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three.';
    const out = chunk(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Para one.');
    expect(out[0]).toContain('Para three.');
  });

  it('emits a fresh chunk when adding a paragraph would overflow maxChars', () => {
    const para = 'a'.repeat(800);
    const text = `${para}\n\n${para}`;
    const out = chunk(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNKER_OPTIONS.maxChars);
    }
  });

  it('overlaps adjacent multi-paragraph chunks by approximately `overlap` chars', () => {
    // Para1 + para2 must exceed maxChars (1500) to force a new chunk.
    const para1 = `${'A'.repeat(800)} END_OF_FIRST`; // 813 chars
    const para2 = 'B'.repeat(800); // 800 chars
    const text = `${para1}\n\n${para2}`; // 1615 chars total → must split
    const out = chunk(text);
    expect(out).toHaveLength(2);
    // Second chunk's prefix is the trailing 200-char tail of the first,
    // which includes "END_OF_FIRST" since it's at the end of para1.
    expect(out[1]).toContain('END_OF_FIRST');
  });

  it('hard-splits a single oversized paragraph with the documented stride', () => {
    const opts = { maxChars: 100, overlap: 20 };
    const text = 'x'.repeat(250);
    const out = chunk(text, opts);
    // Stride = 80; expect ceil((250 - 100) / 80) + 1 = 3 windows.
    expect(out).toHaveLength(3);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(opts.maxChars);
    }
  });

  it('NFC-normalizes input so composed and decomposed strings produce the same chunks', () => {
    const composed = 'Café au lait.';
    const decomposed = 'Café au lait.';
    expect(composed).not.toBe(decomposed);
    expect(chunk(composed)).toEqual(chunk(decomposed));
  });

  it('strips leading/trailing whitespace per chunk and discards empties', () => {
    const text = '   hello   \n\n   \n\n   world   ';
    const out = chunk(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^hello\n\nworld$/);
  });

  it('uses contract default constants when no options passed', () => {
    expect(DEFAULT_CHUNKER_OPTIONS.maxChars).toBe(CHUNKER_MAX_CHARS);
    expect(DEFAULT_CHUNKER_OPTIONS.overlap).toBe(CHUNKER_OVERLAP);
  });

  it('rejects pathological options (overlap >= maxChars)', () => {
    expect(() => chunk('x', { maxChars: 100, overlap: 100 })).toThrow(/smaller than maxChars/);
    expect(() => chunk('x', { maxChars: 100, overlap: 200 })).toThrow();
  });
});
