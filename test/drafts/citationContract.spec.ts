import { describe, expect, it } from 'vitest';

import {
  assembleDraft,
  buildDraftFrontmatter,
  extractCitations,
  markUncited,
  reconcileCitations,
  validateCitationPolicy,
} from '../../src/drafts/citationContract';
import type { CitedChunk } from '../../src/drafts/types';

describe('extractCitations', () => {
  it('extracts a simple wikilink citation', () => {
    const refs = extractCitations('We agreed on [[2025-08-21-sync]].');
    expect(refs).toEqual([{ notePath: '2025-08-21-sync' }]);
  });

  it('extracts header-anchored citations', () => {
    const refs = extractCitations(
      'The decision was in [[2025-08-21-sync#decisions]].',
    );
    expect(refs).toEqual([{ notePath: '2025-08-21-sync', header: 'decisions' }]);
  });

  it('drops aliases — only the target is meaningful', () => {
    const refs = extractCitations('See [[2025-08-21-sync|the standup]].');
    expect(refs).toEqual([{ notePath: '2025-08-21-sync' }]);
  });

  it('deduplicates repeated citations to the same target', () => {
    const refs = extractCitations('A [[x]] and another [[x]] and [[x#h]].');
    expect(refs).toEqual([{ notePath: 'x' }, { notePath: 'x', header: 'h' }]);
  });

  it('returns empty when no citations are present', () => {
    expect(extractCitations('plain prose')).toEqual([]);
  });
});

describe('reconcileCitations', () => {
  const chunks: CitedChunk[] = [
    { notePath: '10-Inbox/a.md', chunkIndex: 0, score: 0.9 },
    { notePath: '10-Inbox/a.md', chunkIndex: 1, score: 0.75 },
    { notePath: '20-Notes/b.md', chunkIndex: 0, score: 0.82 },
  ];

  it('matches citations against retrieved chunks and keeps the best score', () => {
    const { cited, unmatched } = reconcileCitations(
      [{ notePath: '10-Inbox/a.md' }, { notePath: '20-Notes/b.md' }],
      chunks,
    );
    expect(cited).toEqual([
      { notePath: '10-Inbox/a.md', chunkIndex: 0, score: 0.9 },
      { notePath: '20-Notes/b.md', chunkIndex: 0, score: 0.82 },
    ]);
    expect(unmatched).toEqual([]);
  });

  it('reports unmatched citations separately', () => {
    const { cited, unmatched } = reconcileCitations(
      [{ notePath: '10-Inbox/a.md' }, { notePath: '99-Unknown/x.md' }],
      chunks,
    );
    expect(cited).toHaveLength(1);
    expect(unmatched).toEqual([{ notePath: '99-Unknown/x.md' }]);
  });

  it('deduplicates citations to the same chunk', () => {
    const { cited } = reconcileCitations(
      [{ notePath: '10-Inbox/a.md' }, { notePath: '10-Inbox/a.md', header: 'h' }],
      chunks,
    );
    expect(cited).toHaveLength(1);
  });
});

describe('validateCitationPolicy', () => {
  it('free policy always passes', () => {
    expect(validateCitationPolicy('whatever', 'free')).toEqual({ ok: true });
    expect(validateCitationPolicy('synthesis with no cite', 'free')).toEqual({ ok: true });
  });

  it('strict policy passes when every paragraph cites', () => {
    const body =
      'The plan changed [[notes]].\n\nThe team agreed [[sync]].';
    expect(validateCitationPolicy(body, 'strict')).toEqual({ ok: true });
  });

  it('strict policy fails on an uncited paragraph', () => {
    const body = 'Cited paragraph [[x]].\n\nUncited synthesis.';
    const result = validateCitationPolicy(body, 'strict');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no citation/);
    }
  });

  it('marked policy accepts uncited paragraphs wrapped in HTML comments', () => {
    const body =
      'Cited [[x]].\n\n<!-- uncited -->\nSynthesis prose.\n<!-- /uncited -->';
    expect(validateCitationPolicy(body, 'marked')).toEqual({ ok: true });
  });

  it('marked policy rejects bare uncited paragraphs', () => {
    const body = 'Cited [[x]].\n\nUnmarked synthesis.';
    const result = validateCitationPolicy(body, 'marked');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/neither cited nor wrapped/);
    }
  });

  it('marked policy rejects paragraphs that are both cited AND marked', () => {
    const body = '<!-- uncited -->\nCited but marked [[x]].\n<!-- /uncited -->';
    const result = validateCitationPolicy(body, 'marked');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/both cited and/);
    }
  });

  it('skips headings, list items, and code fences', () => {
    const body =
      '# A heading\n\n- A list item\n- Another item\n\n```\ncode block\n```\n\nA cited paragraph [[x]].';
    expect(validateCitationPolicy(body, 'strict')).toEqual({ ok: true });
  });

  it('skips paragraphs that are pure-link references', () => {
    const body = 'Cited [[x]].\n\n[[reference-only]]';
    expect(validateCitationPolicy(body, 'strict')).toEqual({ ok: true });
  });
});

describe('buildDraftFrontmatter', () => {
  it('emits the expected YAML structure', () => {
    const frontmatter = buildDraftFrontmatter({
      topic: 'Q3 synthesis',
      draftingModel: 'claude-opus-4-7',
      generatedAt: 1_700_000_000,
      citedChunks: [
        { notePath: '10-Inbox/a.md', chunkIndex: 0, score: 0.8765 },
        { notePath: '20-Notes/b.md', chunkIndex: 2, score: 0.7 },
      ],
    });
    expect(frontmatter).toContain("topic: 'Q3 synthesis'");
    expect(frontmatter).toContain('drafting_model: claude-opus-4-7');
    expect(frontmatter).toContain('generated_at: 1700000000');
    expect(frontmatter).toContain('quarantine: true');
    expect(frontmatter).toContain(
      "- { note: '10-Inbox/a.md', chunk: 0, score: 0.877 }",
    );
    expect(frontmatter).toContain(
      "- { note: '20-Notes/b.md', chunk: 2, score: 0.7 }",
    );
  });

  it('emits an empty cited_chunks array when there are no citations', () => {
    const fm = buildDraftFrontmatter({
      topic: 'x',
      draftingModel: 'claude-sonnet-4-6',
      generatedAt: 1,
      citedChunks: [],
    });
    expect(fm).toContain('cited_chunks: []');
  });

  it("escapes apostrophes in single-quoted YAML strings (YAML 1.2: double the quote)", () => {
    const fm = buildDraftFrontmatter({
      topic: "thad's q3 plan",
      draftingModel: 'claude-opus-4-7',
      generatedAt: 1,
      citedChunks: [],
    });
    expect(fm).toContain("topic: 'thad''s q3 plan'");
  });
});

describe('assembleDraft', () => {
  it('joins frontmatter and body with a blank line and trailing newline', () => {
    const out = assembleDraft('---\ntopic: x\n---', 'Body content.\n\nMore.');
    expect(out).toBe('---\ntopic: x\n---\n\nBody content.\n\nMore.\n');
  });
});

describe('markUncited', () => {
  it('wraps a paragraph in the open/close marker comments', () => {
    expect(markUncited('Synthesis.')).toBe(
      '<!-- uncited -->\nSynthesis.\n<!-- /uncited -->',
    );
  });

  it('is idempotent — already-marked paragraphs pass through', () => {
    const already = '<!-- uncited -->\nx\n<!-- /uncited -->';
    expect(markUncited(already)).toBe(already);
  });
});
