---
title: "ADR-014: Phase 3 close — read layer shipped as v0.2.3"
type: decision
status: "Accepted"
date: 2026-05-09
---

## Context

Phase 3 (Read Layer) is the v0.1 ship goal per the original spec: side panel chat, retrieval-grounded answers with citations, 5 vault tools, conversation logging, daily token+dollar budget caps. The phase opened with ADR-007 (hybrid embedding strategy) and ADR-010 (pair-via-claude-code build process). It closes with v0.2.3 working end-to-end against a 357-file vault: 319 notes embedded, 1,663 chunks indexed, zero errors, Vault QA query returning a sourced Hangar-voice answer with `[[wikilink]]` citations.

What shipped:
- Chat (general) + Vault QA modes via right-sidebar panel
- `Cmd+P → Quick question` modal
- 5 tools: `read_note`, `list_folder`, `search_vault`, `get_backlinks`, `get_graph_neighborhood`
- Conversation logging to `70-Memory/conversations/YYYY-MM-DD/{session}.md` with `tools_used` + `notes_referenced` frontmatter
- Daily budget caps (200K tokens / $10 / day, midnight reset in `America/Los_Angeles`)
- Anthropic SDK fallback model on overload
- HuggingFace Inference Providers router for embeddings, with graceful no-token degradation
- Auto-on-save indexing mode + manual `Build/Rebuild` commands
- 167 tests, all green

What was punted to Phase 4+:
- Write layer (diff-first edits, transaction log, undo) — **= Phase 4, v0.5 milestone**
- Mobile support (still `isDesktopOnly: true` per ADR-007)
- Self-hosted embedding endpoint for strict-compliance vaults
- Smarter chunking (semantic boundaries vs the contract-§2 1500/200 fixed window)
- The community-plugin registry submission — needs Phase 10 polish first

## The four bugs of v0.2.x

The phase shipped in four releases over two days, each fixing a layer of failure the previous release exposed. Worth recording because each bug points at a class of mistake we want to avoid.

### v0.2.0 — original ship

ADR-013 chose HF Inference API + pure `fetch()` over local transformers.js (which had failed in ADR-012 because Obsidian's Electron renderer rejected the bundled WASM/onnxruntime stack). Shipped.

### v0.2.1 — CORS via `requestUrl()`

`Build retrieval index` produced a wall of:

> `Access to fetch at 'https://api-inference.huggingface.co/models/...' from origin 'app://obsidian.md' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`

ADR-013 had assumed pure `fetch()` would "sidestep every renderer issue." Wrong. HF Inference doesn't return permissive CORS headers, and Obsidian's renderer is bound by browser preflight. Fix: route through `requestUrl()` which runs in Electron's main process. Adapter is dependency-injected for testability.

**Lesson:** every cross-origin call from an Obsidian plugin must use `requestUrl()` unless the target server explicitly allows `app://obsidian.md`. Future ADRs touching the network layer must verify this before signing off.

### v0.2.2 — endpoint URL deprecation

CORS fixed, next Build Index returned 404s:

> `HfInferenceFactory: 404 from https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2: <pre>Cannot POST /models/sentence-transformers/all-MiniLM-L6-v2</pre>`

HF retired the legacy "Hosted Inference API" route and replaced it with the "Inference Providers" router. New endpoint format:

```
https://router.huggingface.co/hf-inference/models/{MODEL}/pipeline/feature-extraction
```

One-line constant change.

**Lesson:** when bypassing an SDK to call a hosted API directly, the URL is part of the contract — and HF, like every other model gateway, evolves theirs. Either bundle the official SDK so URL evolution is the SDK's problem, or version-pin the endpoint pattern in `embed_interface.md` and budget time to rev it.

### v0.2.3 — vault walker

CORS + URL both fixed, indexer reported `0 notes / 0 chunks` even on scratch rebuild. Diagnosis confirmed in console: `app.vault.getMarkdownFiles().length` returned `357`; the indexer found `0`. Root cause: `Indexer.collectFiles()` recursively walked via `adapter.list()`, calling `list('')` on the vault root. In production Obsidian that throws; the silent `try/catch` around it continued the loop, queue emptied, walker returned `[]`. Three releases shipped past this bug because the test FakeAdapters faithfully implemented `list()` with a populated `tree` map — the production failure path was never exercised.

Fix: drop the recursive walker entirely. Use Obsidian's canonical `app.vault.getMarkdownFiles()` for enumeration. New `listAllMarkdown()` method on the `VaultAdapter` interface keeps the abstraction testable.

**Lesson:** test fakes that implement an interface "correctly" can hide real bugs in production code paths if the production environment violates an unstated invariant the fake assumes. When a third-party API has historically been finicky (Obsidian's `DataAdapter.list()` on root), prefer the higher-level idiomatic API (`Vault.getMarkdownFiles()`) over a more general-but-fragile primitive.

## Decision

Mark Phase 3 done. Update CLAUDE.md phase map. Phase 4 (Write Layer) is next, but no work starts on it without an ADR drafting the diff-first / transaction-log / undo plan first per ADR-010.

Record the four bugs above as ADR-014's body so the next time we wire a network-bound feature, we check:
1. Does this work from Obsidian's renderer or do we need `requestUrl()`?
2. Is the URL pattern current as of today, or did the vendor move?
3. Is there an idiomatic Obsidian API for this enumeration / file operation?
4. Do our test fakes exercise the same code path the production adapter takes?

## Follow-ups (carry into Phase 4)

- Bundle `@huggingface/inference` SDK at the start of Phase 4 so URL evolution is the SDK's problem. Re-shape `HfInferenceFactory` to wrap the SDK rather than reimplementing the wire protocol.
- Audit the rest of `VaultAdapter` for primitives that might fail the same way `list('')` did. Prefer `Vault` API methods over `DataAdapter` where possible.
- Consider a "smoke test" command (`Sagittarius: System check`) that pings HF, lists vault, runs a 1-note encode/search round-trip, and reports pass/fail in a Notice — would have surfaced each of the four v0.2.x bugs in seconds without leaving Obsidian.

## Related

- [ADR-007](2026-05-04-sagittarius-q1-q3-signoff.md) — original Phase 3 sign-off, hybrid embeddings, desktop-only v1.0.
- [ADR-010](2026-05-04-sagittarius-build-process.md) — pair-via-claude-code build process, used for every PR in this phase.
- [ADR-011](2026-05-06-sqlite-shipping-strategy.md) — sql.js shipping; held up across all four releases without modification.
- [ADR-012](2026-05-07-defer-retrieval-to-v02.md) — deferral of retrieval after transformers.js failed in renderer.
- [ADR-013](2026-05-08-hf-inference-embedding-strategy.md) — HF Inference API strategy + two postscripts (CORS, URL deprecation).
