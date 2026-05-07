import { describe, expect, it } from 'vitest';

import { splitFrontmatter } from '../../src/util/frontmatter';

describe('splitFrontmatter', () => {
  it('parses YAML frontmatter and separates body', () => {
    const out = splitFrontmatter('---\ntitle: Hello\ntags: [a, b]\n---\nBody text.');
    expect(out.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(out.body).toBe('Body text.');
  });

  it('returns null frontmatter for non-YAML notes', () => {
    const out = splitFrontmatter('Just a body.');
    expect(out.frontmatter).toBeNull();
    expect(out.body).toBe('Just a body.');
  });

  it('returns null frontmatter and raw body on malformed YAML', () => {
    const raw = '---\ntags: [unclosed\n---\nBody.';
    const out = splitFrontmatter(raw);
    expect(out.frontmatter).toBeNull();
    expect(out.body).toBe(raw);
  });

  it('returns null for non-object YAML (e.g. an array)', () => {
    const out = splitFrontmatter('---\n- a\n- b\n---\nBody.');
    expect(out.frontmatter).toBeNull();
    expect(out.body).toBe('Body.');
  });
});
