import { CHUNKER_MAX_CHARS, CHUNKER_OVERLAP } from '../retrieval/SqliteEngine';

/**
 * Chunker per the embedding contract §2:
 *
 *   - max_chars: 1500 (target maximum per chunk)
 *   - overlap: 200 (overlap between adjacent chunks)
 *   - boundary: paragraph (split on `\n\s*\n`)
 *   - hard_split_threshold: max_chars (long paragraphs are
 *     hard-split with stride `max_chars - overlap`)
 *   - whitespace: strip leading/trailing on every emitted chunk
 *   - empty_chunks: discard
 *
 * Both Sagittarius (TypeScript) and corpus-ingest (Python) must
 * produce byte-identical chunks for the same NFC-normalized input.
 * Cross-validation against the Python implementation is a v0.1
 * acceptance task.
 *
 * @example
 *   const chunks = chunk('long text…');
 *   // → ['paragraph 1', 'paragraph 2 + overlap…', …]
 */
export interface ChunkerOptions {
  maxChars: number;
  overlap: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  maxChars: CHUNKER_MAX_CHARS,
  overlap: CHUNKER_OVERLAP,
};

const PARAGRAPH_SPLIT = /\n\s*\n/;

/**
 * Chunk a markdown body into ≤max_chars segments. Input is
 * NFC-normalized first per contract §2.
 * @example const chunks = chunk(body);
 */
export function chunk(text: string, opts: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS): string[] {
  if (opts.overlap >= opts.maxChars) {
    throw new Error(
      `Chunker: overlap (${opts.overlap}) must be smaller than maxChars (${opts.maxChars}).`,
    );
  }

  const normalized = text.normalize('NFC');
  const paragraphs = normalized
    .split(PARAGRAPH_SPLIT)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  const out: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > opts.maxChars) {
      // Flush current before hard-splitting an oversized paragraph.
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      out.push(...hardSplit(para, opts));
      continue;
    }

    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= opts.maxChars) {
      current = candidate;
      continue;
    }

    // Adding this paragraph would overflow → emit current and start a
    // fresh chunk that overlaps the tail of the last one.
    out.push(current);
    const tail = current.length > opts.overlap ? current.slice(-opts.overlap) : current;
    current = `${tail}\n\n${para}`;
  }

  if (current.length > 0) {
    out.push(current);
  }

  return out.map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Hard-split an oversized paragraph into overlapping windows. Each
 * window is up to `maxChars` long; consecutive windows share `overlap`
 * trailing chars. Stride = maxChars - overlap.
 */
function hardSplit(text: string, opts: ChunkerOptions): string[] {
  const stride = opts.maxChars - opts.overlap;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += stride) {
    const slice = text.slice(i, i + opts.maxChars).trim();
    if (slice.length > 0) {
      out.push(slice);
    }
    if (i + opts.maxChars >= text.length) {
      break;
    }
  }
  return out;
}
