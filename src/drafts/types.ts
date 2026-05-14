/**
 * Phase 8 (v1.1.1) — types for the generative drafting layer per ADR-026.
 *
 * A `Draft` is a quarantined markdown note in `_drafts/<topic-folder>/`
 * (D1 (b)) produced by the `DraftingEngine`. Each draft carries inline
 * citation markers (D2 (a)) and a `cited_chunks: [...]` frontmatter
 * array (D2 (e)) that the promotion path will verify.
 *
 * Drafts ARE NOT a new diff-card variant (D9 (a)) — they're regular
 * `create_note` proposals whose target path starts with `_drafts/`.
 * Promotion is a `move_note` proposal that strips the prefix (D7 (a)).
 */

/** One vault chunk that grounded a draft paragraph. Mirrors `QueryResult` shape but only the fields the citation contract needs. */
export interface CitedChunk {
  /** Vault-relative path of the source note. */
  notePath: string;
  /** Zero-indexed chunk number within that note. */
  chunkIndex: number;
  /**
   * Cosine similarity at retrieval time. Persisted to frontmatter so a
   * future "verify citations still match" pass can compare against
   * the current index without re-running the query.
   */
  score: number;
}

/**
 * Per-paragraph citation policy per ADR-026 D3. Controls how the
 * drafting engine handles synthesis / transition prose that isn't
 * directly grounded in a retrieved chunk.
 *
 *   `'strict'` — every sentence must cite. The engine retries up to
 *     once if the output contains uncited prose; on second failure
 *     the draft is returned with an explicit `[CITATION_REQUIRED]`
 *     marker the user must resolve.
 *   `'marked'` — uncited prose is allowed but wrapped in
 *     `<!-- uncited -->...<!-- /uncited -->` HTML comments. Visible
 *     to the user, retrievable by tooling. Default per ADR-026.
 *   `'free'` — uncited prose passes through unannotated. Trust the
 *     reader. Reserved for power users.
 */
export type CitationPolicy = 'strict' | 'marked' | 'free';

/**
 * What the user provides when invoking `Sagittarius: New draft`.
 * The engine fills in retrieval + body + citations; the caller fills
 * in `topic` and (optionally) `destinationFolder`.
 */
export interface DraftSpec {
  /**
   * Human topic — the modal's text input. Free-form. Used to embed
   * for retrieval AND as the seed for slug + filename. Example:
   *   "Q3 roadmap synthesis from leadership-sync notes"
   */
  topic: string;
  /**
   * Vault-relative folder where the canonical note would live AFTER
   * promotion. The draft itself lands at `_drafts/<destinationFolder>/<slug>.md`.
   * Omit to use `settings.draftsDefaultDestination`.
   */
  destinationFolder?: string;
  /**
   * How many retrieved chunks to feed the drafting model. Default
   * `retrievalK * 2` since drafting benefits from breadth more than
   * chat does. Cap is enforced at the retrieval layer.
   */
  retrievalLimit?: number;
}

/**
 * The drafting engine's output. Caller (main.ts command handler)
 * packages this into a `create_note` proposal whose path is the
 * draft path and content is the body with frontmatter prepended.
 */
export interface Draft {
  /** Vault-relative draft path, e.g. `_drafts/30-Projects/q3-roadmap-synthesis.md`. */
  path: string;
  /** Original topic input — surfaced in frontmatter for later UI. */
  topic: string;
  /**
   * Markdown body with inline `[[note-path]]` citation markers and
   * `<!-- uncited -->` comments where applicable. Does NOT include
   * the frontmatter block — the writer (`create_note` proposal
   * builder) prepends it from `citedChunks`.
   */
  body: string;
  /**
   * Chunks the engine used for grounding, in order of citation
   * appearance. Persisted as `cited_chunks: [...]` frontmatter.
   */
  citedChunks: CitedChunk[];
  /** Drafting model identifier — surfaced in frontmatter for audit. */
  draftingModel: string;
  /** Epoch seconds when the engine finished. */
  generatedAt: number;
  /**
   * `true` when the engine fell back from `'strict'` mode because the
   * retry produced uncited prose. Caller can warn the user before
   * the diff card opens. Always `false` for `'marked'` / `'free'`.
   */
  strictFallback: boolean;
}
