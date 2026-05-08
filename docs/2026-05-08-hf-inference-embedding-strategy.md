---
title: "ADR-013: v0.2 embedding strategy — HuggingFace Inference API"
type: decision
status: "Accepted"
date: 2026-05-08
deciders: [Thad]
supersedes:
superseded-by:
tags: [decision, ADR, sagittarius, embeddings, retrieval, v0.2]
---

# ADR-013: v0.2 embedding strategy — HuggingFace Inference API

> **Status:** Accepted by Thad on 2026-05-08.
> **Context:** v0.1.0 shipped without retrieval (ADR-012) because transformers.js's environment didn't survive Obsidian's Electron renderer. v0.2 needs a working embedding path to bring `search_vault` and vault-qa mode back online.

## Context

[ADR-012](2026-05-07-defer-retrieval-to-v02.md) deferred retrieval to v0.2 with four candidate strategies enumerated:

1. **HuggingFace Inference API** — network call per encode, no local model.
2. **Wait for transformers.js v3** — different env model; might Just Work.
3. **Pre-compute embeddings via `corpus-ingest`** — Python pipeline runs separately, ships a `.sqlite` file plugin reads.
4. **Anthropic-first-party embeddings** — doesn't exist as of cutoff.

This ADR picks (1).

## Decision

**Use HuggingFace's Inference API** at `https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2` for v0.2 embeddings.

## Why this candidate over the others

### vs. (2) wait for transformers.js v3
v3 might fix the env detection, or might not. ETA unknown. We don't ship by waiting. (2) becomes a future migration option if HF Inference API hits a wall.

### vs. (3) pre-compute via corpus-ingest
Architecturally clean — the model never runs in the browser. But operationally heavy: every Sagittarius user would need a working `corpus-ingest` Python install, would need to re-run after every vault edit, and Obsidian wouldn't know when the index is stale. Defeats the "open vault, ask questions" ergonomics. Better fit for v0.5+ when we have a richer indexing pipeline.

### vs. (4) Anthropic embeddings
Anthropic doesn't ship an embedding API as of 2026-05. Non-starter today. If they ship one, v0.3 may switch.

### Why HF Inference API
- **Works in any browser/renderer.** Pure `fetch()` to a public HTTPS endpoint. No fs cache, no Node-vs-browser env detection, no native modules — sidesteps every issue PRs #17–#19 hit.
- **Same model.** The contract pins `sentence-transformers/all-MiniLM-L6-v2`; HF's hosted version of that exact model returns 384-d L2-normalized vectors with mean pooling — bit-exact (up to FP rounding) compatible with `corpus-ingest`'s local PyTorch output.
- **Free tier covers v0.1 scale.** ~30K chunks × batched 100 inputs/req = ~300 requests for a cold rebuild. HF free tier limits are well above. Per-query cost = 1 request.
- **No bundle weight.** Removes ~3 MB of transformers.js + onnxruntime-web from `main.js` when the chunker eventually wires up. Stays at ~1.25 MB through v0.2.

## What this means concretely

**v0.2 settings additions:**
- `huggingfaceApiKey: string` — user gets a free token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) (just needs "read" scope).
- Stored in plugin data dir alongside the Anthropic key. Same gitignore protection.

**v0.2 plumbing:**
- New `src/retrieval/HfInferenceFactory.ts` returns an `EmbedPipelineFactory` that posts to HF's API. Drop-in replacement for the old transformers.js factory; existing `EmbedClient` API surface unchanged.
- `main.ts buildAgent` instantiates `EmbedClient` with the HF factory if `huggingfaceApiKey` is set. If empty, gracefully degrades: no `search_vault` registered, vault-qa disabled, otherwise behaves like v0.1.1.
- `RetrievalLayer` + `IndexCoordinator` re-wired exactly as the pre-deferral code planned.

**v0.2 default behavior change vs. pre-deferral plan:**
- **Auto-index on plugin load is OFF** (`indexingMode: 'manual'` default). Previously planned auto. Reasoning: indexing now costs network calls; surprising the user with 30s of HF traffic on first plugin load is bad UX. User runs `Cmd+P → Build Index` once, then incremental rebuilds on edit (still TODO for v0.3 — file-watcher hook).

**Cold-start handling:**
- HF returns `503` + `{"error": "Model is currently loading", "estimated_time": <seconds>}` on the first request to a cold model. Wrap encode calls with a "wait `estimated_time + 1` seconds, retry once" helper. Subsequent requests are warm.

## Consequences

### Positive
- v0.2 ships retrieval. The 5th tool (`search_vault`) and vault-qa mode come back online.
- Spec §1 success-criterion query 1 (*"Where does Phase 1 stand?"*) starts working without the user having to specify a file.
- Bundle size effectively unchanged (no transformers.js).
- Mobile path stays open — HF Inference API works on iOS/Android renderers too.

### Negative / cost
- **Network dependency.** No HF, no retrieval. (Chat-mode + 4 vault-API tools still work offline.)
- **Per-request latency.** ~100–300 ms per encode batch. Indexing a fresh 354-file vault takes ~30s wall clock. Per-query latency adds ~200ms before the agent can search.
- **Privacy surface widens.** Vault chunk text is sent to HuggingFace's servers during indexing. Per HF's terms, they don't train on inference-API inputs, but operators with strict-compliance vaults should disable retrieval and ship a future option to use a self-hosted HF endpoint (Phase 5+).
- **Free-tier rate limits.** Above ~1000 req/hour the user hits a paywall. Realistic for normal usage; flagged in release notes.
- **Vendor lock to HF.** Mitigated by the `EmbedPipelineFactory` abstraction — swapping HF for a different provider is a single-file change.

### Reversible?
Fully. The plugin-side touchpoint is one factory function. v0.3 can:
- Switch to a different inference API (Cohere, Voyage, OpenAI embeddings, etc.) by writing a new factory.
- Switch back to local transformers.js if v3 fixes the env story.
- Layer a corpus-ingest precomputed cache in front of HF for users who want offline retrieval.

## Follow-up

If accepted:
- [ ] Implement `src/retrieval/HfInferenceFactory.ts`.
- [ ] Add `huggingfaceApiKey` to `SagittariusSettings` + Settings tab.
- [ ] Wire retrieval back into `main.ts buildAgent` with graceful no-token degradation.
- [ ] Re-enable vault-qa option in `ChatView`.
- [ ] Add `Build Index (incremental)` and `Rebuild Index from scratch` commands.
- [ ] Cold-start retry helper with the `estimated_time` wait.
- [ ] Tests for HfInferenceFactory (fetch-mocked: success path, cold-start retry, rate-limit error, wrong-shape response).
- [ ] Bump 0.1.1 → 0.2.0; tag + release.
- [ ] Update README to point users at `huggingface.co/settings/tokens` + add a smoke-test query that exercises `search_vault`.

## Postscript — 2026-05-08, v0.2.1 patch

The original ADR claimed pure `fetch()` would "sidestep every Obsidian-renderer issue." That was wrong. v0.2.0 shipped, the `Build Index` command fired, and the renderer console filled with:

> `Access to fetch at 'https://api-inference.huggingface.co/models/...' from origin 'app://obsidian.md' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.`

HF's Inference API does not return permissive CORS headers, and Obsidian's renderer process is bound by browser CORS preflight. Zero requests succeeded.

**Fix in v0.2.1** (`src/retrieval/obsidianRequestUrl.ts`): adapt Obsidian's `requestUrl()` API to the `FetchLike` shape and inject it into `makeHfInferenceFactory()`. `requestUrl()` issues HTTP from Electron's main process, which is not subject to renderer CORS at all. The adapter is dependency-injected (takes `requestUrl` as a parameter) so `HfInferenceFactory` stays test-friendly with mocked fetches.

**Lesson:** "use fetch from the renderer" is not a free architectural choice in an Obsidian plugin — every cross-origin call has to go through `requestUrl()` unless the target server explicitly allows `app://obsidian.md`. Future ADRs that touch the network layer must verify this before signing off.

## Related

- [ADR-007](2026-05-04-sagittarius-q1-q3-signoff.md) — original hybrid embedding decision; (1) is one of the two paths it sketched.
- [ADR-011](2026-05-06-sqlite-shipping-strategy.md) — sql.js shipping; unaffected, still in use.
- [ADR-012](2026-05-07-defer-retrieval-to-v02.md) — the deferral this ADR resolves.
- [`embed_interface.md`](embed_interface.md) — embedding contract still binding; HF API output must match `corpus-ingest` byte-identically (within FP rounding).
