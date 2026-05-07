# CLAUDE.md — agent shim for `obsidian-claude-conduit`

This file orients a Claude Code session opened against this repo. Substrate questions ("what's the spec? what tools? what schema?") defer to `docs/`.

## Repo identity

- **Name:** Sagittarius — Claude Conduit (`obsidian-claude-conduit`)
- **What:** Native Obsidian plugin. Chat with your vault, retrieval-grounded.
- **Status:** v0.1.0 (Phase 3 — read layer in progress; Phase 3e-3b shipped, 3e-3c next).
- **Build pattern:** `pair-via-claude-code` per [`docs/2026-05-04-sagittarius-build-process.md`](docs/2026-05-04-sagittarius-build-process.md) (ADR-010). Thad decides; Claude implements.

## Current state (updated 2026-05-07, post-PR-#11)

- **`main` HEAD:** chat-mode end-to-end works. Settings tab + side panel + Cmd+P modal all wired.
- **4 of 5 v0.1 tools registered:** `read_note`, `list_folder`, `get_backlinks`, `get_graph_neighborhood`. **`search_vault` deferred to 3e-3c.**
- **Tests:** 111/111 green (vitest). CI green on main.
- **Bundle:** `main.js` = 1.25 MB. sql.js wasm inlined; `@xenova/transformers` still tree-shaken (will add ~3 MB when retrieval gets wired).
- **No pending ADR drafts.** ADR-011 (sql.js) accepted; spec §10 Q2 resolved.

## Read first (in this order)

1. [`docs/02_SPEC.md`](docs/02_SPEC.md) — v0.1 spec (binding).
2. [`docs/03_PACKAGE_JSON.md`](docs/03_PACKAGE_JSON.md) — dependency rationale.
3. [`docs/04_MANIFEST_JSON.md`](docs/04_MANIFEST_JSON.md) — Obsidian manifest fields.
4. [`docs/05_CONDUIT_AGENT_SKETCH.md`](docs/05_CONDUIT_AGENT_SKETCH.md) — agent class shape (now implemented in `src/agent/ConduitAgent.ts`).
5. [`docs/2026-05-04-sagittarius-build-process.md`](docs/2026-05-04-sagittarius-build-process.md) — ADR-010 (process).
6. [`docs/2026-05-06-sqlite-shipping-strategy.md`](docs/2026-05-06-sqlite-shipping-strategy.md) — ADR-011 (sql.js, Accepted).
7. [`docs/embed_interface.md`](docs/embed_interface.md) — embedding contract v1 (shared with corpus-ingest).
8. [`docs/sdk-migration-notes.md`](docs/sdk-migration-notes.md) — `@anthropic-ai/sdk` 0.32 → 0.95 patches (now applied in `ConduitAgent`).
9. [`docs/THAD_MAN.md`](docs/THAD_MAN.md) — vault constitution; loaded into the agent's system prompt at runtime.
10. [`docs/concierge.md`](docs/concierge.md) — Hangar voice; loaded into the agent's system prompt.

## Decision authority hierarchy

When unsure (per ADR-010 §4):

1. Match against `docs/02_SPEC.md` + ADR-007 + ADR-009 + ADR-010 + ADR-011 + the embedding contract → proceed.
2. Spec doesn't cover this? → propose a conservative default; flag in PR.
3. Deviation from spec? → STOP. Surface in PR. Wait for Thad.
4. Architectural change? → file an ADR draft in `docs/`. Don't merge.

## Quality gates (per spec §8)

- **Types:** no `any` except FFI boundaries with a `// TODO: type` comment.
- **Tests:** every tool gets a unit test; tests ship with the feature.
- **Errors:** every thrown error is actionable.
- **Docs:** every exported function gets a one-line purpose + example.

## House rules (from `docs/THAD_MAN.md`)

1. Never auto-respond to a FortressFlow reply.
2. The vault is the system of record.
3. First principles. Complexity science. No buzzword soup.
4. Failures get a one-line lesson.

## Phase map

| Phase | Output | Status |
|---|---|---|
| 1 — Spec | `docs/02_SPEC.md` etc. | ✅ done |
| 2 — Scaffold | `npm`/`tsc`/`esbuild`/lint/manifest/CI | ✅ done (PRs #1, #2) |
| 3 — Read layer | `= v0.1 ship` | 🟡 in progress |
| 3a | unblock open questions + ADR-011 + sql.js swap | ✅ done (PRs #2, #3) |
| 3b | `SqliteEngine` + byte-identical-with-CLI test | ✅ done (PR #4) |
| 3c | `EmbedClient` + `RetrievalLayer` | ✅ done (PR #5) |
| 3d-1 | `ToolRegistry` + `read_note` | ✅ done (PR #6) |
| 3d-2 | 4 remaining tools | ✅ done (PR #7) |
| 3e-1 | Settings + `BudgetTracker` + `ConversationLogger` | ✅ done (PR #8) |
| 3e-2 | `ConduitAgent` chat loop | ✅ done (PR #9) |
| 3e-3a | `SagittariusSettingTab` + plugin settings persistence | ✅ done (PR #10) |
| 3e-3b | `ChatView` + `QuickQuestionModal` + agent integration | ✅ done (PR #11) |
| **3e-3c** | **chunker + indexer + `search_vault` tool + Build Index UI → v0.1 ship** | **next** |
| 4 — Write layer | diff-first writes, transaction log, undo | future |
| 5 — Organization engine | auto-routing, MOC maintenance — `= v0.5` | future |
| 6 — Activity stream + MCP bridge | events, alerts, digest | future |
| 7 — Curator | proactive suggestions | future |
| 8 — Generative layer | cited drafts, proposal quarantine | future |
| 9 — Memory layer | CLAUDE.md reader/writer, dossiers | future |
| 10 — Polish | commands, hotkeys, screenshots | future |
| 11 — Release | tag, sign, BRAT-list, registry — `= v1.0` | future |

## Phase 3e-3c — what's next (kickoff brief for the next session)

**Goal:** complete v0.1's read layer by adding the indexing pipeline and `search_vault` tool. Once landed, all 13 acceptance gates from spec §8 are unblocked.

**Likely deliverables:**
- `src/indexing/Chunker.ts` — implements the contract §2 chunking rules (1500-char target, 200 overlap, paragraph boundary, NFC normalize).
- `src/indexing/Indexer.ts` — walks the vault (excluding `20-Corpus/`), chunks each note, encodes via `EmbedClient`, persists to `SqliteEngine`. Tracks unchanged files via mtime to make re-runs idempotent.
- `src/indexing/IndexPersistence.ts` — read/write `.sqlite` via vault adapter (binary).
- `src/agent/tools/search_vault.ts` registered in `main.ts buildAgent()` (already implemented in 3c, just not registered).
- `RetrievalLayer` wired into `buildAgent()` with the persistent self-engine + optional corpus-engine.
- "Build index" command + button (settings tab or chat panel header).
- vault-qa option in `ChatView` re-enabled.

**Bundle warning:** Phase 3e-3c is when `@xenova/transformers` first lands on the entry-point chain (via `EmbedClient`). `main.js` will jump from 1.25 MB to roughly 4 MB. ADR-011 anticipated this.

**Open question for kickoff:** background-index on plugin load (auto mode per spec §3.1), or explicit user-triggered build only? Spec §3.1 says default `indexingMode: 'auto'` — auto means "on startup + on edit." Empirically this could be slow first-run. Probably ship "manual only" for v0.1 with auto deferred to v0.5; flag in 3e-3c PR description.

**Testability:** `Chunker` is pure function — easy. `Indexer` needs `VaultAdapter` + `EmbedClient` mocks (both already established patterns). `IndexPersistence` round-trips a buffer.

## Quality gates this session inherits

- ✅ `npm run typecheck` — must stay clean.
- ✅ `npm run lint` — must stay clean.
- ✅ `npm test` — 111/111. Don't regress.
- ✅ `npm run build` — must stay clean.

## Scope of this repo

- **In scope:** TypeScript plugin code, tests, build/CI, docs.
- **Out of scope:** vault content (lives in the operator's private `gengyveusa/my-obsidian-vault`), spec amendments without an ADR, architectural pivots, auto-merging your own PRs, adding deps not listed in `docs/03_PACKAGE_JSON.md` without surfacing rationale.

## How to say "I don't know"

> Spec gap: `<what>`. My best guess: `<X>`. Risk if wrong: `<Y>`. Should I proceed with `<X>` or wait for your call?
