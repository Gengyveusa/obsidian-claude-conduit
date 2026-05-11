import { describe, expect, it } from 'vitest';

import { setFrontmatterField } from '../../src/writes/frontmatterOps';

describe('setFrontmatterField', () => {
  it('creates a frontmatter block when none exists', () => {
    const out = setFrontmatterField('hello\nbody', 'title', 'Hello');
    expect(out).toBe('---\ntitle: Hello\n---\nhello\nbody');
  });

  it('upserts a key into an existing block, preserving other keys', () => {
    const c = '---\ntags:\n  - a\n  - b\n---\nbody';
    const out = setFrontmatterField(c, 'title', 'New');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('title: New');
    expect(out).toContain('- a');
    expect(out).toContain('- b');
    expect(out.endsWith('\nbody')).toBe(true);
  });

  it('updates an existing field rather than duplicating it', () => {
    const c = '---\ntitle: Old\n---\nbody';
    const out = setFrontmatterField(c, 'title', 'New');
    expect(out).toContain('title: New');
    expect(out).not.toContain('Old');
    // Only one frontmatter delimiter pair
    const opens = out.match(/^---$/gm)?.length ?? 0;
    expect(opens).toBe(2);
  });

  it('serializes number values', () => {
    const out = setFrontmatterField('body', 'priority', 3);
    expect(out).toContain('priority: 3');
  });

  it('serializes boolean values', () => {
    const out = setFrontmatterField('body', 'archived', true);
    expect(out).toContain('archived: true');
  });

  it('serializes string-array values as YAML lists', () => {
    const out = setFrontmatterField('body', 'tags', ['alpha', 'beta']);
    expect(out).toMatch(/tags:\s*\n\s*-\s*alpha\s*\n\s*-\s*beta/);
  });

  it('preserves the body verbatim (no leading-newline drift)', () => {
    const c = '---\nx: 1\n---\nbody with\nmultiple lines';
    const out = setFrontmatterField(c, 'y', 2);
    expect(out.endsWith('body with\nmultiple lines')).toBe(true);
  });

  it('throws when the key is empty', () => {
    expect(() => setFrontmatterField('body', '', 'x')).toThrow(/non-empty/);
  });

  it('throws when the existing frontmatter block is malformed YAML', () => {
    const c = '---\nbad: [unclosed\n---\nbody';
    expect(() => setFrontmatterField(c, 'x', 'y')).toThrow(/malformed/);
  });

  it('treats a body that happens to contain "---" as no frontmatter', () => {
    // Body without a leading frontmatter delimiter — just write a fresh block
    const out = setFrontmatterField('mid-doc separator:\n---\nstill body', 'x', 1);
    expect(out.startsWith('---\nx: 1\n---\nmid-doc')).toBe(true);
  });
});
