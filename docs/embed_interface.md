# Embedding Service Interface Contract — corpus-ingest ↔ Sagittarius

> **Status:** v1.0 draft (2026-05-04). Both consumers honor this contract.
> **Owners:** [[Assets/code/corpus-ingest/parsers/embed]] (Python writer, indexes `20-Corpus/`) and the future Sagittarius plugin (TypeScript writer, indexes the rest of the vault).
> **Per:** [[20-Decisions/2026-05-04-sagittarius-q1-q3-signoff|ADR-007]] decision Q2 — one canonical local embedding model per vault, multiple consumers.
>
> When this contract changes, **bump the major version** and coordinate the bump in both implementations. Schema migrations require both surfaces to agree before either runs.

---

## 1. Model

| Field | Value |
|---|---|
| **Model name** | `sentence-transformers/all-MiniLM-L6-v2` |
| **Vector dimension** | `384` |
| **Vector dtype** | `float32` |
| **Distance** | cosine similarity |
| **Tokenizer source** | bundled with model |

**Why this model:** small (~22 MB), CPU-only, fast, available in both Python (`sentence-transformers`) and TypeScript (`transformers.js` / ONNX-WASM) with bit-identical outputs when the same ONNX export is used.

**No alternative models in the local path.** If a consumer wants a different model, it goes through the **opt-in cloud path** (Voyage AI per ADR-007) which writes to a *separate* index. The local path is single-model by contract.

---

## 2. Chunking

| Field | Value |
|---|---|
| `max_chars` | `1500` (target maximum per chunk) |
| `overlap` | `200` (overlap between adjacent chunks) |
| `boundary` | paragraph (split on `\n\s*\n`) |
| `hard_split_threshold` | `max_chars` — if a single paragraph exceeds, hard-split with `max_chars - overlap` stride |
| `whitespace` | strip leading/trailing on every emitted chunk |
| `empty_chunks` | discard |

**Both consumers apply identical chunking.** A chunk produced by Python and a chunk produced by TypeScript over the same input must be byte-identical (after Unicode NFC normalization).

---

## 3. Storage — SQLite schema

Both consumers write to SQLite databases with **this exact schema**. Each consumer owns its own DB file:

| Consumer | DB path | Scope |
|---|---|---|
| corpus-ingest (Python) | `20-Corpus/.embeddings.db` | Notes under `20-Corpus/` only |
| Sagittarius (TS) | `.obsidian/plugins/obsidian-claude-conduit/index.sqlite` | Whole vault EXCEPT `20-Corpus/` (corpus-ingest owns those) |

### Schema v1

```sql
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    note_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,                    -- 384 × float32, little-endian, raw bytes (1536 bytes)
    UNIQUE(note_path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_path ON chunks(note_path);

CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,                      -- vault-relative path with forward slashes
    title TEXT,
    source TEXT,                                -- e.g. "claude" | "gamma" | "vault" | "publication"
    doctrine_alignment TEXT,                    -- corpus-ingest only; Sagittarius writes NULL
    last_modified REAL,                         -- mtime float epoch seconds
    chunk_count INTEGER
);

CREATE TABLE IF NOT EXISTS schema_meta (        -- v1 addition; both consumers write this row
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Required rows in schema_meta on every DB:
-- ('schema_version', '1'),
-- ('model', 'sentence-transformers/all-MiniLM-L6-v2'),
-- ('vector_dim', '384'),
-- ('vector_dtype', 'float32'),
-- ('chunker_max_chars', '1500'),
-- ('chunker_overlap', '200'),
-- ('writer', 'corpus-ingest' | 'sagittarius'),
-- ('writer_version', '<semver of the writer>')
```

### Encoding rules

- `note_path` is **vault-relative** with forward slashes regardless of OS.
- `embedding` is a **raw little-endian f32 buffer of length 1536 bytes** (384 × 4). No JSON, no base64, no length prefix.
- `last_modified` is a **POSIX epoch float** (seconds, fractional). Match `os.path.getmtime` in Python and `Stats.mtimeMs / 1000` in Node.
- `text` is the chunk **after** frontmatter strip. Frontmatter does not get embedded.

---

## 4. Build semantics (writer functions)

Both consumers expose a `build(rebuild: bool) -> BuildResult` function with these semantics:

```python
def build(rebuild: bool = False) -> BuildResult:
    """
    Idempotent: re-running with rebuild=False is a no-op for unchanged files
    (judged by mtime within 1.0 second tolerance).
    rebuild=True deletes the DB and re-indexes from scratch.
    """
```

```typescript
async function build(opts: { rebuild: boolean }): Promise<BuildResult>
```

**`BuildResult` shape (both languages):**

```ts
type BuildResult = {
  notes_processed: number;
  chunks_added: number;
  chunks_skipped: number;     // unchanged-mtime skip
  errors: Array<{ path: string; error: string }>;
  duration_ms: number;
};
```

**Mandatory invariants:**
- After a successful `build`, the `schema_meta` rows MUST be current.
- `notes.chunk_count` MUST equal `COUNT(*) FROM chunks WHERE note_path = ?`.
- A failed file ingest MUST NOT leave partial chunks (`DELETE FROM chunks WHERE note_path = ?` runs before insert).
- Concurrent writers to the same DB are NOT supported. Each consumer owns its own DB file. Period.

---

## 5. Query semantics (reader function)

Both consumers expose a `query` function:

```python
def query(q: str, limit: int = 10, doctrine: str | None = None,
          source: str | None = None) -> list[QueryResult]:
    """
    Cosine sim against all chunks; optional filter by doctrine_alignment or source.
    Returns top-`limit` results sorted by score descending.
    """
```

```typescript
async function query(q: string, opts: {
  limit?: number;
  doctrine?: string;
  source?: string;
  source_db?: 'self' | 'corpus' | 'both';   // Sagittarius extension — see §6
}): Promise<QueryResult[]>
```

**`QueryResult` shape (both languages):**

```ts
type QueryResult = {
  path: string;                 // vault-relative
  chunk: number;                // chunk_index
  title: string | null;
  source: string | null;        // "claude" | "gamma" | "vault" | etc.
  doctrine: string | null;      // doctrine_alignment, may be null
  score: number;                // cosine sim, 0–1 (clamped from [-1, 1] noise)
  text: string;                 // chunk text, truncated to 300 chars by default with "..." marker
  // Sagittarius extension only:
  source_db?: 'self' | 'corpus';
};
```

**Query invariants:**
- Cosine sim is computed in f32. Implementations may use SIMD; numerical tolerance is `±1e-6` between Python NumPy and TypeScript SIMD.
- `limit > 0` always. Default 10. Hard cap at 100 to prevent runaway queries.
- Empty `q` returns `[]` immediately, not an error.

---

## 6. Cross-surface unified query (Sagittarius only)

Sagittarius is the surface where users actually search. corpus-ingest's Python isn't running inside Obsidian. So Sagittarius implements the **unified query** that reads from BOTH DBs:

```typescript
async function queryUnified(q: string, opts: {
  limit?: number;
  source_db?: 'self' | 'corpus' | 'both';   // default 'both'
}): Promise<QueryResult[]>
```

Behavior:
- Open `index.sqlite` (Sagittarius own) and `20-Corpus/.embeddings.db` (corpus-ingest's) as read-only.
- Verify both have `schema_meta.schema_version == '1'` and `model == 'sentence-transformers/all-MiniLM-L6-v2'`. If either disagrees → error with actionable message ("rebuild corpus-ingest with `python -m parsers.embed --rebuild` to align schema").
- Encode the query string ONCE.
- Query both DBs; merge result lists by score.
- Tag each result with `source_db: 'self' | 'corpus'`.
- Return top-`limit`.

**corpus-ingest does NOT need a unified-query function.** The Python CLI (`python -m parsers.embed --query "..."`) only reads its own DB. That's a deliberate scope limit.

---

## 7. Voyage opt-in path (separate index)

Per ADR-007 Q2, Voyage is opt-in for users who want higher retrieval quality. **It writes to a SEPARATE index** (different DB file), not the local one:

| Field | Value |
|---|---|
| **Model** | `voyage-3` (or `voyage-3-lite` for the budget-conscious) |
| **Vector dimension** | `1024` (voyage-3) or `512` (voyage-3-lite) |
| **DB path** | `.obsidian/plugins/obsidian-claude-conduit/index_voyage.sqlite` |
| **Schema** | identical to §3 except `embedding BLOB` is `vector_dim × 4` bytes |
| **schema_meta.model** | `voyage-3` or `voyage-3-lite` |

`queryUnified` extends to query local + corpus + voyage when configured, with a `source_db` tag of `'voyage'` for those rows. Score-merging across different embedding spaces is heuristic — surface results separately or run a re-ranker before merging.

---

## 8. Versioning

This contract is at **v1.0**. Versioning rules:

| Change type | Version bump | Coordination |
|---|---|---|
| New optional field in `QueryResult` or `BuildResult` | minor (1.0 → 1.1) | new field IGNORED by older consumer; safe |
| New table or new column with default | minor | new column IGNORED by older consumer; safe |
| Change to chunking parameters | **MAJOR** (1.x → 2.0) | requires re-index of both DBs; coordinate via ADR |
| Change to model | **MAJOR** | full re-index; coordinate via ADR; old vectors discarded |
| Schema rename or required new column | **MAJOR** | migration script required; coordinate via ADR |

**Version reference for both consumers:** `schema_meta.writer_version` records the consumer's own version; this contract version is implicit at v1.0 and bumped via this file.

---

## 9. Failure modes

| Symptom | Cause | Action |
|---|---|---|
| `queryUnified` errors with "schema mismatch" | One DB at v1, other at v2 | Re-index the lagging consumer with `--rebuild`. |
| Sagittarius can't open `20-Corpus/.embeddings.db` | corpus-ingest never ran, or `.embeddings.db` is gitignored on this clone | Run `python -m parsers.embed` first; verify `.gitignore` doesn't exclude on read paths. |
| Embeddings file size unexpectedly small | mtime skip is too aggressive | `--rebuild` to force; consider tightening tolerance below 1.0 sec. |
| Cosine sim returns `NaN` | Empty embedding (all zeros) | Skip empty texts in chunking; assert `np.linalg.norm > 0` before insert. |

---

## 10. Open questions for v1.1

These are explicitly NOT decided in v1.0; named here so they don't get decided implicitly:

- **Re-rankers.** Should `queryUnified` run a cross-encoder re-ranker on the top-N before returning? (gengyve-memory-mcp already has a no-op cross-encoder pattern; could share.)
- **Hybrid lexical + dense.** BM25 over `chunks.text` blended with cosine sim. Killer prompt §3.1 mentions BM25 explicitly; not yet specified here.
- **Graph-walk retrieval.** Following `[[wikilinks]]` to expand the candidate set before scoring. Killer prompt §3.1 also mentions; defer to v1.1.
- **Incremental Voyage backfill.** When a user toggles Voyage on, do we re-encode the whole vault immediately or backfill on-query?

When any of these is decided, bump to v1.1 and update §6 / §7.

---

## Related

- [[Assets/code/corpus-ingest/parsers/embed]] — the Python implementation that defines the canonical chunking + storage
- [[20-Decisions/2026-05-04-sagittarius-q1-q3-signoff]] — ADR-007, source of the "one canonical model" mandate
- [[18-Obsidian-Claude-Plugin/00_BUILDER_PROMPT]] — Sagittarius spec §4 (architecture), §3.1 (chat-in-vault retrieval requirements)
- [[20-Decisions/2026-04-27-conduit-doctrine-and-corpus-ingest-ADR-008]] — ADR-008, the corpus-ingest pipeline this interface formalizes
