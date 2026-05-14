import { describe, expect, it } from 'vitest';

import {
  buildTagRenameOps,
  computeFrontmatterRange,
  rewriteBodyLine,
  rewriteFrontmatterLine,
} from '../../src/curator/tagRename';

function ops(content: string, from: string[], canonical: string) {
  return buildTagRenameOps(content, new Set(from.map((t) => t.toLowerCase())), canonical);
}

describe('computeFrontmatterRange', () => {
  it('returns the lines between leading --- markers (exclusive)', () => {
    const lines = ['---', 'title: foo', 'tags: [a]', '---', 'body'];
    expect([...computeFrontmatterRange(lines)].sort()).toEqual([1, 2]);
  });

  it('returns empty when no frontmatter is present', () => {
    expect(computeFrontmatterRange(['no frontmatter here', 'body'])).toEqual(new Set());
  });

  it('returns empty when the opening --- is missing', () => {
    expect(computeFrontmatterRange(['title: foo', '---'])).toEqual(new Set());
  });

  it('returns empty when the closing --- is missing', () => {
    expect(computeFrontmatterRange(['---', 'title: foo', 'body'])).toEqual(new Set());
  });
});

describe('rewriteBodyLine', () => {
  it('rewrites an exact inline tag match', () => {
    expect(rewriteBodyLine('This is #projects.', new Set(['projects']), 'project')).toBe(
      'This is #project.',
    );
  });

  it('rewrites mid-sentence with whitespace boundary', () => {
    expect(
      rewriteBodyLine('start #projects middle #other end', new Set(['projects']), 'project'),
    ).toBe('start #project middle #other end');
  });

  it('preserves nested tag suffix (root match only)', () => {
    expect(
      rewriteBodyLine('see #projects/alpha here', new Set(['projects']), 'project'),
    ).toBe('see #project/alpha here');
  });

  it('case-insensitive match, canonical replaces verbatim', () => {
    expect(rewriteBodyLine('#Projects rocks', new Set(['projects']), 'project')).toBe(
      '#project rocks',
    );
  });

  it('leaves heading lines alone', () => {
    expect(rewriteBodyLine('## projects', new Set(['projects']), 'project')).toBe('## projects');
  });

  it('does not split a longer tag (no partial-word match)', () => {
    // `#projector` contains `project` as a prefix but `project` is not the full root.
    expect(rewriteBodyLine('#projector launch', new Set(['project']), 'projects')).toBe(
      '#projector launch',
    );
  });

  it('leaves untargeted tags alone', () => {
    expect(rewriteBodyLine('#cats and #dogs', new Set(['projects']), 'project')).toBe(
      '#cats and #dogs',
    );
  });

  it('rewrites multiple occurrences on the same line', () => {
    expect(
      rewriteBodyLine('#projects #proj together', new Set(['projects', 'proj']), 'project'),
    ).toBe('#project #project together');
  });
});

describe('rewriteFrontmatterLine', () => {
  it('rewrites inline array tags', () => {
    expect(
      rewriteFrontmatterLine('tags: [projects, other]', new Set(['projects']), 'project'),
    ).toBe('tags: [project, other]');
  });

  it('rewrites quoted inline array entries and keeps the quote style', () => {
    expect(
      rewriteFrontmatterLine('tags: ["projects", "other"]', new Set(['projects']), 'project'),
    ).toBe('tags: ["project", "other"]');
  });

  it('rewrites scalar form', () => {
    expect(rewriteFrontmatterLine('tags: projects', new Set(['projects']), 'project')).toBe(
      'tags: project',
    );
  });

  it('rewrites list item form', () => {
    expect(rewriteFrontmatterLine('  - projects', new Set(['projects']), 'project')).toBe(
      '  - project',
    );
  });

  it('leaves untargeted list items unchanged', () => {
    expect(rewriteFrontmatterLine('  - other', new Set(['projects']), 'project')).toBe(
      '  - other',
    );
  });

  it('passes through non-tag frontmatter lines', () => {
    expect(rewriteFrontmatterLine('title: foo', new Set(['projects']), 'project')).toBe(
      'title: foo',
    );
  });
});

describe('buildTagRenameOps', () => {
  it('returns an empty array when no tags need rewriting', () => {
    expect(ops('hello world', ['projects'], 'project')).toEqual([]);
  });

  it('returns an empty array when fromTags is empty', () => {
    expect(buildTagRenameOps('#projects', new Set(), 'project')).toEqual([]);
  });

  it('emits one replace op per affected body line', () => {
    const content = ['line one #projects', 'line two', 'line three #projects'].join('\n');
    const result = ops(content, ['projects'], 'project');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      kind: 'replace',
      startLine: 1,
      endLine: 1,
      content: 'line one #project',
    });
    expect(result[1]).toEqual({
      kind: 'replace',
      startLine: 3,
      endLine: 3,
      content: 'line three #project',
    });
  });

  it('emits ops for frontmatter and body together', () => {
    const content = [
      '---',
      'title: foo',
      'tags: [projects, other]',
      '---',
      '',
      'see #projects below',
    ].join('\n');
    const result = ops(content, ['projects'], 'project');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'replace', startLine: 3 });
    expect(result[1]).toMatchObject({ kind: 'replace', startLine: 6 });
  });

  it('handles multi-member clusters', () => {
    const content = '#projects and #proj';
    const result = ops(content, ['projects', 'proj'], 'project');
    expect(result).toEqual([
      { kind: 'replace', startLine: 1, endLine: 1, content: '#project and #project' },
    ]);
  });

  it('skips body lines that already use the canonical', () => {
    expect(ops('#project rocks', ['projects'], 'project')).toEqual([]);
  });
});
