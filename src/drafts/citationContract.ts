import type { CitationPolicy, CitedChunk, Draft } from './types';

/**
 * Phase 8 (v1.1.1) — citation contract per ADR-026 D2 + D3.
 *
 * Pure parser + assembler. The drafting engine produces a body with
 * inline `[[note-path]]` markers; this module
 *   1. extracts the citations,
 *   2. cross-references them against the chunks the engine retrieved,
 *   3. assembles the final markdown (frontmatter + body),
 *   4. validates the policy (`strict` / `marked` / `free`).
 *
 * No I/O. The retrieval-chunk verification (does this cited chunk
 * still exist in the index?) is a Slice 2 concern — Slice 1 verifies
 * intra-draft consistency only ("every `[[]]` in the body resolves to
 * a chunk the engine actually retrieved").
 */

/** Regex for inline wikilink citations: `[[note-path]]` or `[[note-path|alias]]` or `[[note-path#header]]`. */
const CITE_PATTERN = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/** HTML comments wrapping uncited prose per ADR-026 D3 `'marked'` mode. */
const UNCITED_OPEN = '<!-- uncited -->';
const UNCITED_CLOSE = '<!-- /uncited -->';

/**
 * Parse `[[path]]` and `[[path#header]]` markers from a draft body.
 * Returns the deduplicated set of (notePath, header?) tuples in
 * appearance order. Aliases (`[[path|alias]]`) are stripped — only
 * the target is meaningful for citation.
 *
 * @example
 *   extractCitations('The plan is [[2025-08-21-sync#decisions]].')
 *   // → [{ notePath: '2025-08-21-sync', header: 'decisions' }]
 */
export function extractCitations(body: string): CitationRef[] {
  const seen = new Set<string>();
  const out: CitationRef[] = [];
  for (const match of body.matchAll(CITE_PATTERN)) {
    const notePath = match[1].trim();
    const header = match[2]?.trim();
    const key = `${notePath}#${header ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const ref: CitationRef = { notePath };
    if (header !== undefined && header.length > 0) {
      ref.header = header;
    }
    out.push(ref);
  }
  return out;
}

/** One citation reference parsed from a draft body. */
export interface CitationRef {
  notePath: string;
  header?: string;
}

/**
 * Cross-reference body citations against the chunks the engine
 * retrieved. Returns the `CitedChunk[]` to persist in frontmatter:
 * one entry per body citation that matches a retrieved chunk.
 * Citations to notes that weren't retrieved are reported via
 * `unmatched` so the caller can decide whether to surface them
 * (strict mode = error; marked/free = warn).
 *
 * Note-path match is exact — `'10-Inbox/foo.md'` must appear in
 * both the citation and a retrieved chunk's `notePath`. We don't
 * stem `.md` suffixes because Obsidian's link syntax accepts both
 * `[[foo]]` and `[[foo.md]]` but our retrieval stores the full
 * path. The engine's system prompt instructs it to use full paths.
 */
export function reconcileCitations(
  citations: ReadonlyArray<CitationRef>,
  retrievedChunks: ReadonlyArray<CitedChunk>,
): { cited: CitedChunk[]; unmatched: CitationRef[] } {
  // Build a path → best-scoring-chunk map so multiple citations to
  // the same note collapse onto one record per chunk.
  const bestByPath = new Map<string, CitedChunk>();
  for (const chunk of retrievedChunks) {
    const existing = bestByPath.get(chunk.notePath);
    if (existing === undefined || chunk.score > existing.score) {
      bestByPath.set(chunk.notePath, chunk);
    }
  }
  const cited: CitedChunk[] = [];
  const unmatched: CitationRef[] = [];
  const used = new Set<string>();
  for (const ref of citations) {
    // Citations may include `.md` or not; normalize for lookup.
    const normalized = normalizeCitePath(ref.notePath);
    const candidate = bestByPath.get(normalized) ?? bestByPath.get(`${normalized}.md`);
    if (candidate === undefined) {
      unmatched.push(ref);
      continue;
    }
    const key = `${candidate.notePath}#${candidate.chunkIndex}`;
    if (used.has(key)) {
      continue;
    }
    used.add(key);
    cited.push(candidate);
  }
  return { cited, unmatched };
}

function normalizeCitePath(p: string): string {
  return p.trim();
}

/**
 * Validate a draft body against the supplied citation policy per
 * ADR-026 D3. Returns `{ ok: true }` when the body conforms.
 *
 *   `'strict'` — every paragraph must contain at least one citation.
 *     A paragraph is text between blank lines (excluding headings,
 *     code fences, lists, frontmatter-style lines).
 *   `'marked'` — uncited paragraphs MUST be wrapped in
 *     `<!-- uncited --> ... <!-- /uncited -->`. Cited paragraphs
 *     MUST NOT be wrapped (the comment is a "this is opinion"
 *     signal, not noise).
 *   `'free'` — always returns `ok: true`.
 *
 * Headings (`# ...`), list items, and code fences are skipped — they
 * carry no propositional content the citation contract applies to.
 */
export function validateCitationPolicy(
  body: string,
  policy: CitationPolicy,
): { ok: true } | { ok: false; reason: string } {
  if (policy === 'free') {
    return { ok: true };
  }
  const paragraphs = splitParagraphs(body);
  for (const p of paragraphs) {
    if (shouldSkipForPolicy(p.text)) {
      continue;
    }
    const hasCite = CITE_PATTERN.test(p.text);
    CITE_PATTERN.lastIndex = 0;
    const isMarked = p.text.includes(UNCITED_OPEN);
    if (policy === 'strict') {
      if (!hasCite) {
        return {
          ok: false,
          reason: `strict policy: paragraph at line ${p.lineNumber} has no citation`,
        };
      }
      continue;
    }
    if (policy === 'marked') {
      if (!hasCite && !isMarked) {
        return {
          ok: false,
          reason:
            `marked policy: paragraph at line ${p.lineNumber} is neither cited ` +
            `nor wrapped in <!-- uncited --> comments`,
        };
      }
      if (hasCite && isMarked) {
        return {
          ok: false,
          reason:
            `marked policy: paragraph at line ${p.lineNumber} is both cited and ` +
            `marked uncited — pick one`,
        };
      }
    }
  }
  return { ok: true };
}

interface Paragraph {
  text: string;
  lineNumber: number;
}

function splitParagraphs(body: string): Paragraph[] {
  const lines = body.split('\n');
  const out: Paragraph[] = [];
  let buf: string[] = [];
  let startLine = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      if (buf.length > 0) {
        out.push({ text: buf.join('\n'), lineNumber: startLine });
        buf = [];
      }
      startLine = i + 2;
      continue;
    }
    if (buf.length === 0) {
      startLine = i + 1;
    }
    buf.push(line);
  }
  if (buf.length > 0) {
    out.push({ text: buf.join('\n'), lineNumber: startLine });
  }
  return out;
}

function shouldSkipForPolicy(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (trimmed.startsWith('#')) {
    return true;
  }
  if (trimmed.startsWith('```')) {
    return true;
  }
  // Skip list items — they're typically pointers, not claims.
  if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
    return true;
  }
  // Skip pure-marker paragraphs (e.g. a paragraph that is just a
  // `[[link]]` with nothing else — those are reference pointers).
  if (/^(\[\[[^\]]+\]\]\s*)+$/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Build the YAML frontmatter block to prepend to a draft body. Mirrors
 * the curator's frontmatter conventions: simple key:value pairs, no
 * complex nesting. The `cited_chunks` array is one line per entry to
 * keep diffs readable.
 */
export function buildDraftFrontmatter(draft: Pick<Draft, 'topic' | 'citedChunks' | 'draftingModel' | 'generatedAt'>): string {
  const lines: string[] = ['---'];
  lines.push(`topic: ${yamlString(draft.topic)}`);
  lines.push(`drafting_model: ${draft.draftingModel}`);
  lines.push(`generated_at: ${draft.generatedAt}`);
  lines.push('quarantine: true');
  if (draft.citedChunks.length === 0) {
    lines.push('cited_chunks: []');
  } else {
    lines.push('cited_chunks:');
    for (const c of draft.citedChunks) {
      // Inline-object YAML — `- { note: 'path', chunk: 0, score: 0.87 }` —
      // keeps each entry on one line for clean diffs.
      lines.push(
        `  - { note: ${yamlString(c.notePath)}, chunk: ${c.chunkIndex}, score: ${roundScore(c.score)} }`,
      );
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Combine frontmatter + body into the final draft markdown to write.
 * Pure helper; the engine builds the frontmatter via
 * `buildDraftFrontmatter` and the body itself, then calls this to
 * produce the bytes that `create_note` writes.
 */
export function assembleDraft(frontmatter: string, body: string): string {
  return `${frontmatter}\n\n${body.trimEnd()}\n`;
}

function yamlString(s: string): string {
  // Conservative — always quote, escape single quotes by doubling.
  // YAML 1.2 single-quoted strings escape only `'` (as `''`).
  return `'${s.replace(/'/g, "''")}'`;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

/**
 * Wrap an uncited paragraph in the `marked`-policy HTML comment pair.
 * Used by the drafting engine when constructing the body OR as a
 * post-hoc transform if the model returns uncited prose without the
 * markers.
 */
export function markUncited(paragraph: string): string {
  if (paragraph.includes(UNCITED_OPEN)) {
    return paragraph;
  }
  return `${UNCITED_OPEN}\n${paragraph}\n${UNCITED_CLOSE}`;
}
