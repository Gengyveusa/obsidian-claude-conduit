---
title: "ADR-011: SQLite shipping strategy — sql.js over better-sqlite3"
type: decision
status: "Accepted"
date: 2026-05-06
created: 2026-05-06
updated: 2026-05-06
deciders: [Thad]
supersedes:
superseded-by:
tags: [decision, ADR, sagittarius, sqlite, distribution]
related:
  - "[[2026-05-04-sagittarius-q1-q3-signoff]]"
  - "[[2026-05-04-sagittarius-build-process]]"
  - "[[02_SPEC]]"
  - "[[03_PACKAGE_JSON]]"
  - "[[embed_interface]]"
---

# ADR-011: SQLite shipping strategy — sql.js over better-sqlite3

> **Status:** Accepted by Thad on 2026-05-06.
> **Supersedes:** the provisional answer in [`02_SPEC.md` §10 Q2](02_SPEC.md) ("`better-sqlite3` — speed wins") and the dependency choice in [`03_PACKAGE_JSON.md`](03_PACKAGE_JSON.md).

## Context

The embedding contract ([`embed_interface.md`](embed_interface.md) §3) mandates a shared SQLite schema: `chunks`, `notes`, `schema_meta`. Both `corpus-ingest` (Python, native `sqlite3`) and Sagittarius (TypeScript) write/read this schema. The contract pins the **schema**, not the **engine**.

`02_SPEC.md` §10 listed engine choice as an open Phase-2 question with a provisional Curator answer of `better-sqlite3` (faster, desktop-only restriction already in place). At the time of authoring, the cost of choosing `better-sqlite3` was treated as zero — "just install it." Phase 3a research surfaced that this is not true in Obsidian's distribution model.

### How Obsidian plugins actually ship

GitHub releases bundle `main.js + manifest.json + styles.css`. Users get those files into `.obsidian/plugins/<id>/` via BRAT (or, for community-listed plugins, through the in-app browser). **There is no `npm install` step on the user's machine.** Native modules with `.node` bindings have no canonical path to the user's filesystem.

Plugins that need `better-sqlite3` work around this by asking users to manually download per-platform `.node` binaries from a GitHub release and unzip them into `.obsidian/`:

- **`windily-cloud/obsidian-sqlite3`** — README ships per-platform zips (`103-darwin-arm64.zip`, `103-linux-x64.zip`, `103-win32-x64.zip`). Author notes automating this is "very annoying" especially on Windows (node-gyp + Python + MS2022 + .NET).
- **`WWF2022/obsidian-sqlite3-plugin`** — fork of the above; same friction.
- **ZotLit (`aidenlx/zotlit`)** — shows a first-run modal asking the user to download the binary; runtime works around the missing binary.
- **Obsidian forum thread `forum.obsidian.md/t/88272`** documents that `better-sqlite3`'s `bindings` package additionally fails inside Obsidian's Electron renderer because it parses stack traces to locate the `.node` file, and Obsidian's runtime breaks `getFileName`. Workarounds use `module-alias` to redirect resolution.

This is a load-bearing UX defect, not a minor friction. The Sagittarius v0.1 success criteria ([`02_SPEC.md` §1](02_SPEC.md)) require Hangar-voice answers grounded in the vault. If users can't get past install, the success criteria are unreachable.

### What other Obsidian retrieval plugins do

- **Smart Connections** (`brianpetro/obsidian-smart-connections`, the most-installed embeddings plugin) avoids SQLite entirely — stores embeddings as `.ajson` files in `.smart-env/`.
- **Obsidian Copilot** (`logancyang/obsidian-copilot`) uses **Orama** (pure-JS vector DB) — bundles cleanly into `main.js`.
- **Neural Composer** uses **PGLite** (Postgres-WASM) persisted as a `.tar.gz` via `vault.adapter.writeBinary()`.
- **`stfrigerio/sqliteDB`** uses **sql.js** (WASM); ships the `.wasm` file as a separate release asset users drop into the plugin folder.

## Decision

**Use `sql.js` (WASM) for the Sagittarius SQLite engine, with the `sql-wasm.wasm` binary base64-inlined into `main.js` via esbuild's binary loader.**

Concretely:

- Drop `better-sqlite3` and `@types/better-sqlite3` from `package.json`. Add `sql.js`.
- esbuild config gains `loader: { '.wasm': 'binary' }` and an inlined wasm import.
- `EmbedClient` and `RetrievalLayer` use sql.js's API (`new SQL.Database(buffer)` for read; `db.export()` to obtain a `Uint8Array` for write).
- DB files persist to disk via Obsidian's vault adapter (`adapter.writeBinary` / `adapter.readBinary`).
- The shared schema in [`embed_interface.md`](embed_interface.md) §3 is honored byte-identically — sql.js produces standard SQLite v3 files readable by Python's `sqlite3` and any other engine.

## Alternatives considered

### Alt 1: `better-sqlite3` + per-platform binaries shipped as release assets

User downloads the right `.node` for their platform on first install. **Rejected.** Three independent plugins have tried this; all report adoption-blocking friction. Obsidian's `bindings` resolution bug compounds the problem.

### Alt 2: `@sqlite.org/sqlite-wasm` (official sqlite.org WASM)

Faster than sql.js (~2-3× on bulk inserts), built-in FTS5 + JSON1, official upstream support. **Rejected for v0.1.** No proven Obsidian shipping story. OPFS persistence isn't usable in Obsidian's Electron renderer; Node-FS VFS would require a custom shim. Worth revisiting in v0.5 if sql.js perf bites.

### Alt 3: Drop SQLite entirely; use Orama or `.ajson` files

Removes the WASM dependency and would simplify shipping. **Rejected.** Violates the embedding contract — `corpus-ingest`'s Python pipeline writes SQLite, and `queryUnified` reads both DBs. Switching engines unilaterally on the Sagittarius side would require either coordinating a contract bump (more substantial than this ADR) or losing the cross-surface shared-index property.

### Alt 4: Defer engine choice; ship a stub for Phase 3 and decide later

**Rejected.** The retrieval layer's API surface differs materially between sync (`better-sqlite3`) and async (`sql.js`) engines. Choosing late means refactoring every call site. Decide once.

## Consequences

### Positive

- **Single-`main.js` distribution preserved.** No release assets beyond the canonical three. No first-run user friction.
- **Mobile-ready.** v1.1+ Android/iOS support per ADR-007 needs sql.js anyway — `better-sqlite3` will never run on iOS.
- **No native-binding compatibility hell** on every Obsidian / Electron / Node bump.
- **Cross-surface contract preserved** — sql.js writes byte-identical SQLite v3 files readable by Python.

### Negative / cost

- **~5–10× slower than `better-sqlite3` on large reads.** For v0.1 vault sizes (target 10K notes, ~30–40K chunks at ~3KB each) this is acceptable; cosine-sim over 384-dim vectors is dominated by the math, not the I/O.
- **`main.js` grows from ~1KB scaffold to ~1.5–2 MB** (sql.js WASM is ~1 MB binary; base64-encoded that's ~1.4 MB). Plugin load time gains a few hundred ms. Acceptable for a long-running plugin.
- **Whole-DB-in-memory model.** sql.js loads the entire SQLite file into WASM linear memory. For ~30–40K chunks × ~3 KB each = ~100–120 MB DB, this stresses the [`ADR-010` §5](2026-05-04-sagittarius-build-process.md) perf gate ("10k-note vault stays < 150MB RAM"). Mitigations: (a) chunk text can be truncated in storage if needed; (b) embeddings dominate disk usage and don't need to be loaded as JS objects until queried. **Real-world ceiling probably bites past ~5K notes; revisit in Phase 5 if it's a problem on Thad's actual vault.**
- **No FTS5 in stock sql.js builds.** v0.1 uses semantic search only (per spec §4.3); BM25 hybrid is explicitly Phase 1.1+ ([`embed_interface.md` §10](embed_interface.md)). Not blocking now.
- **Async API.** sql.js queries are sync inside the WASM but the file load is async. Every `RetrievalLayer` call site is async-by-default — agent sketch already assumes this.

### Reversible?

Yes. The query/build API surface for the retrieval layer can be designed engine-agnostically (a `SagittariusDB` interface that sql.js implements today; `@sqlite.org/sqlite-wasm` or `better-sqlite3` could implement it later). Switching engines in Phase 5 would be ~2-day work, not a rewrite.

## Follow-up

If accepted:

- [ ] Update [`docs/03_PACKAGE_JSON.md`](03_PACKAGE_JSON.md): swap `better-sqlite3` for `sql.js`. Drop `@types/better-sqlite3`.
- [ ] Update [`package.json`](../package.json) accordingly. Remove `better-sqlite3` from `esbuild.config.mjs` externals.
- [ ] Add `loader: { '.wasm': 'binary' }` to `esbuild.config.mjs` and a small `loadDatabase()` helper in `src/retrieval/EmbedClient.ts` (or a new `src/retrieval/SqliteEngine.ts`).
- [ ] Update [`02_SPEC.md` §10 Q2](02_SPEC.md) to reflect the resolved decision.
- [ ] First retrieval-layer PR to verify byte-identical SQLite output: write a chunk to sql.js, read it from Python via `sqlite3`, assert schema_meta + row counts match.

## Related

- [`02_SPEC.md` §10 Q2](02_SPEC.md) — the open question this ADR answers.
- [`03_PACKAGE_JSON.md`](03_PACKAGE_JSON.md) — `dependencies` updates.
- [`embed_interface.md`](embed_interface.md) §3 — schema contract this preserves.
- [`2026-05-04-sagittarius-q1-q3-signoff`](https://github.com/gengyveusa/my-obsidian-vault) — ADR-007 (architecture), unaffected.
- [`2026-05-04-sagittarius-build-process.md`](2026-05-04-sagittarius-build-process.md) — ADR-010 §5 perf gates this stresses.

## Decision

- [x] **Accept** — adopted sql.js per this ADR on 2026-05-06. Follow-ups become PR work (see "Follow-up" section above).
- [ ] **Reject** — keep `better-sqlite3`. Document the user-download UX in README and design Phase 3 install flow accordingly.
- [ ] **Modify** — request changes (e.g., go with `@sqlite.org/sqlite-wasm` instead, or defer until vault sizes are measured).
