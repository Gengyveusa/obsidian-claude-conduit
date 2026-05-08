---
title: "ADR-012: Defer semantic retrieval to v0.2 — ship v0.1 chat-mode-only"
type: decision
status: "Accepted"
date: 2026-05-07
deciders: [Thad]
supersedes:
superseded-by:
tags: [decision, ADR, sagittarius, retrieval, v0.1, deferral]
---

# ADR-012: Defer semantic retrieval to v0.2 — ship v0.1 chat-mode-only

> **Status:** Accepted by Thad on 2026-05-07.
> **Context:** Live-vault smoke install. Three iterations of patching transformers.js's environment to work in Obsidian's renderer all failed with the same root cause: undefined paths in transformers.js's internal fs cache logic.

## Context

Phase 3e-3c-2 (PR #14) wired `EmbedClient` (transformers.js / `all-MiniLM-L6-v2`) + `RetrievalLayer` + `search_vault` into the plugin. Phase 3e-3c also added the auto-on-load indexer per ADR-007 + spec §3.1.

The smoke install on Thad's 354-file vault produced:

```
[sagittarius] auto-index: 0 notes, 0 chunks, 0 skipped, 1707ms.
```

Manual rebuild surfaced:

```
[sagittarius] index error on 00_CONCIERGE.md:
  The "path" argument must be of type string or an instance of URL. Received undefined
```

Fired 354 times — once per file, every encode call.

## What we tried

Three PRs of patches against transformers.js's environment:

| PR | Theory | Result |
|---|---|---|
| #17 | `onnxruntime-node` + `sharp` are externalized; their require throws at runtime → stub them with empty modules | "Cannot find module" errors stopped, but next-layer error appeared: undefined-path |
| #18 | transformers.js detects `RUNNING_LOCALLY = true` and tries fs cache; force `useBrowserCache: true` + `allowLocalModels: false` | No effect — flag names not canonical for v2.17 |
| #19 | Shotgun every plausible env flag (`useFS`, `useFSCache`, `useBrowserCache`, `cacheDir = ''`, etc.) | No effect — same path error 354 times |

Each fix surfaced a deeper assumption baked into transformers.js v2 that doesn't hold in Obsidian's Electron renderer. The renderer has Node's `fs` and `path` available (so transformers.js's env detection routes to the local-cache code path), but `process.env` and `env-paths` don't behave the way transformers.js expects, leaving `cacheDir` undefined inside fs operations.

## Decision

**Ship v0.1 chat-mode-only.** Remove the EmbedClient / RetrievalLayer / Indexer / IndexCoordinator wiring from `main.ts buildAgent`. Don't import them, so esbuild tree-shakes transformers.js out of the bundle entirely. Bundle drops from ~2 MB back to ~926 KB.

What v0.1 keeps:
- Side panel chat surface, Cmd+P quick-question modal, settings tab, conversation logging to `70-Memory/conversations/...`, daily token + dollar budget caps, model fallback (Sonnet 4.6 → Opus 4.7 on 503).
- 4 of 5 v0.1 tools registered: `read_note`, `list_folder`, `get_backlinks`, `get_graph_neighborhood`. All hit the real Obsidian API directly. No model load, no fs cache.

What v0.1 defers to v0.2:
- `search_vault` tool (semantic retrieval).
- `vault-qa` mode in `ChatView` (rendered but disabled).
- Auto-index on plugin load.
- Build Index commands.

Source kept (not deleted) for v0.2:
- `src/retrieval/EmbedClient.ts`
- `src/retrieval/RetrievalLayer.ts`
- `src/retrieval/SqliteEngine.ts` (still used for the on-load smoke check)
- `src/indexing/Chunker.ts`
- `src/indexing/Indexer.ts`
- `src/indexing/IndexCoordinator.ts`
- `src/indexing/IndexPersistence.ts`
- All tests (149 passing).

## Why this is the right call

1. **Three PRs of patches without progress is a signal.** transformers.js v2 was designed for Node CLI tools and pure browsers. Obsidian's Electron renderer is a hybrid — has Node `fs` but with restricted `process.env`. transformers.js's environment detection was never tested against this hybrid; we're chasing assumptions baked into its source.
2. **Ship what works.** Chat-mode + 4 vault-API tools is a real product. *"summarize Pipeline_State.md"*, *"who links to harold-wallace?"*, *"what's in 50-FortressFlow?"* all answer correctly via the real Obsidian API. That's >50% of the v0.1 success-criterion queries already.
3. **Other embedding paths exist.** v0.2 can pivot to:
   - **HuggingFace Inference API** (network call, no local model — cleanest fit for Obsidian's renderer).
   - **Wait for transformers.js v3** (different env model; might Just Work).
   - **Pre-compute embeddings via `corpus-ingest`** and ship them as a release asset; plugin only reads.
   - **Anthropic embedding alternative** if/when Anthropic ships a first-party embedding API.
4. **The retrieval-layer code we wrote isn't wasted.** `SqliteEngine`, `Chunker`, `Indexer`, `IndexPersistence`, `RetrievalLayer` all have passing tests and stay in the codebase ready for v0.2.

## Consequences

### Positive
- v0.1 ships. Acceptance gates 1, 2, 3, 9, 10, 13, 14 all pass; gate 8 (conversation log) works for chat mode.
- Bundle size halved: ~2 MB → ~926 KB.
- No model download on first install; no HF CDN dependency at runtime.
- The 4 working tools cover the core "talk to my vault about specific notes" use case.

### Negative
- v0.1 acceptance gates 4, 5, 6, 7 partially fail:
  - Gate 4: only 4 of 5 tools active.
  - Gate 5: spec §1 query 1 (*"Where does Phase 1 stand?"*) requires `search_vault` and won't work as written. Workaround: rephrase as *"summarize 50-FortressFlow/Pipeline_State.md"*.
  - Gate 6: `schema_meta.writer == 'sagittarius'` is still verifiable on the smoke-check engine, just not on a populated index.
  - Gate 7: budget-cap logic still works; just not exercised by an indexer.
- Users can't ask topical questions across the vault without specifying a file path.
- The vault-qa mode option is rendered-but-disabled in the UI, signaling what's coming.

### Reversible?
Fully. v0.2 can wire retrieval back in by:
1. Picking an embedding strategy that works in Obsidian's renderer.
2. Re-importing `EmbedClient` (or its replacement) + `RetrievalLayer` + `IndexCoordinator` in `main.ts buildAgent`.
3. Re-registering `search_vault`.
4. Re-enabling vault-qa in `ChatView`.

Estimated v0.2 work: ~half a day once the embedding strategy is settled.

## Follow-up

- [ ] Update README to reflect v0.1 = chat + 4 vault-API tools.
- [ ] Update CLAUDE.md status banner.
- [ ] Open a v0.2-planning issue listing the four embedding-strategy candidates above; pick one before starting Phase 3e-4.

## Related

- [`02_SPEC.md`](02_SPEC.md) — v0.1 spec; gates 4–7 partially deferred.
- [`2026-05-04-sagittarius-q1-q3-signoff.md`](2026-05-04-sagittarius-q1-q3-signoff.md) — ADR-007, hybrid embedding decision (still valid as design intent for v0.2).
- [`2026-05-06-sqlite-shipping-strategy.md`](2026-05-06-sqlite-shipping-strategy.md) — ADR-011, sql.js (still in use for the smoke check; ready for v0.2 retrieval).
- [`embed_interface.md`](embed_interface.md) — embedding contract; binding when v0.2 ships retrieval.
