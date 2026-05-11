import { describe, expect, it } from 'vitest';

import { findSection, rewriteSection } from '../../src/writes/sectionOps';

describe('findSection', () => {
  it('returns null when the heading is not present', () => {
    expect(findSection('# A\nfoo', '## B')).toBeNull();
  });

  it('finds a level-1 heading and bounds the body to EOF', () => {
    const c = '# Setup\nstep 1\nstep 2';
    expect(findSection(c, '# Setup')).toEqual({
      headingIdx: 0,
      bodyStart: 1,
      bodyEnd: 3,
      depth: 1,
    });
  });

  it('bounds the body at the next same-depth heading', () => {
    const c = '# A\nfoo\n# B\nbar';
    expect(findSection(c, '# A')).toMatchObject({ bodyStart: 1, bodyEnd: 2 });
  });

  it('bounds at the next shallower heading', () => {
    const c = '## A\nfoo\n# B\nbar';
    expect(findSection(c, '## A')).toMatchObject({ bodyStart: 1, bodyEnd: 2 });
  });

  it('includes deeper subheadings inside the body', () => {
    const c = '# Outer\nintro\n## Inner\ndetail\n# Next';
    // # Outer's body runs until '# Next' (next same-depth heading)
    expect(findSection(c, '# Outer')).toMatchObject({ bodyStart: 1, bodyEnd: 4 });
  });

  it('matches headings with trailing whitespace (trimmed before compare)', () => {
    const c = '## A\nfoo\n## B  \nbar';
    expect(findSection(c, '## B')).toMatchObject({ headingIdx: 2 });
  });

  it('returns the first match when multiple headings have the same text', () => {
    const c = '## Setup\nfoo\n## Setup\nbar';
    expect(findSection(c, '## Setup')?.headingIdx).toBe(0);
  });

  it('returns null when targetHeader has no # prefix', () => {
    expect(findSection('# A\nfoo', 'A')).toBeNull();
  });
});

describe('rewriteSection', () => {
  it('replaces a single section body, preserving the heading', () => {
    const out = rewriteSection('# A\nfoo\n# B\nbar', '# A', 'NEW');
    expect(out).toBe('# A\nNEW\n# B\nbar');
  });

  it('replaces a multi-line section body', () => {
    const out = rewriteSection(
      '## A\nold line 1\nold line 2\n## B\nbar',
      '## A',
      'new\nlines',
    );
    expect(out).toBe('## A\nnew\nlines\n## B\nbar');
  });

  it('replaces the last section (body bounded by EOF)', () => {
    const out = rewriteSection('# A\nfoo\n# B\nbar\nbaz', '# B', 'replaced');
    expect(out).toBe('# A\nfoo\n# B\nreplaced');
  });

  it('clears a section to empty (newBody = "")', () => {
    const out = rewriteSection('# A\nfoo\n# B\nbar', '# A', '');
    expect(out).toBe('# A\n\n# B\nbar');
  });

  it('throws when the heading is not present', () => {
    expect(() => rewriteSection('# A\nfoo', '## B', 'x')).toThrow(/no heading/);
  });

  it('preserves nested subheadings when rewriting their parent', () => {
    // Body of '# Outer' = everything until next # — but '# Outer' body
    // INCLUDES the '## Inner' subheading and its content. Rewriting
    // '# Outer' nukes the whole subtree.
    const c = '# Outer\nintro\n## Inner\ndetail\n# Next\ntail';
    const out = rewriteSection(c, '# Outer', 'simplified');
    expect(out).toBe('# Outer\nsimplified\n# Next\ntail');
  });

  it('can rewrite a subsection without touching its parent', () => {
    const c = '# Outer\nintro\n## Inner\ndetail\n# Next';
    const out = rewriteSection(c, '## Inner', 'new detail');
    expect(out).toBe('# Outer\nintro\n## Inner\nnew detail\n# Next');
  });
});
