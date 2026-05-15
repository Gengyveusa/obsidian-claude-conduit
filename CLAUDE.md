# CLAUDE.md — agent shim for `obsidian-claude-conduit`

This file orients a Claude Code session opened against this repo. Substrate questions ("what's the spec? what tools? what schema?") defer to `docs/`.

## Repo identity

- **Name:** Sagittarius — Claude Conduit (`obsidian-claude-conduit`)
- **What:** Native Obsidian plugin. Chat with your vault, retrieval-grounded.
- **Status:** v1.3.4 — citation drift verification lands at promotion, closing the last open v1.3.x deferral. New `src/drafts/citationDrift.ts` (pure — `verifyCitations`, `formatDriftSummary`); before `Sagittarius: Promote draft` fires `move_note`, every `cited_chunks` entry is checked against the current index. Two classes: missing chunks (note exists, chunk index gone — rechunked) and missing notes (source deleted/moved). On drift, a confirmation modal lists every drifted citation; operator can "Promote anyway" (citations are documentation, not contracts) or cancel. Drift-check failure (e.g. engine unavailable) logs a warn and proceeds — never blocks. Now: all three Phase 9 v1.3.x follow-ups complete (ChatView Draft mode v1.3.2, drafting reads memory v1.3.3, citation drift v1.3.4). 1050 tests (+11). Phase 9 close ADR ready when Thad has lived with the surface for a beat. Earlier today: v1.3.3 (drafting reads CLAUDE.md cascade). New optional `memoryProvider` dep on `DraftingEngineDeps`; when set, the resolved memory text appears as a `# Operator memory` block between persona and output-format in the drafting system prompt. Same provider instance ChatView uses; cascade anchors on the active file at the moment New Draft is invoked. Provider errors degrade to "no memory" rather than failing the draft. Both first attempt + retry get the memory block. Three v1.3.x deferrals from earlier today (drafting reads memory, ChatView Draft mode, citation drift) — first two shipped; citation drift still open. 1039 tests (+8). Earlier today (v1.3.2): ChatView Draft mode (ADR-026 D5(d)+D6(c)). When the active file is under `_drafts/`, ChatView shows a "Refining draft: <path>" banner above the messages area and `chat()` is called with the draft path. The agent's system prompt gains a "Mode: DRAFT REFINE" block instructing `patch_note(path='<draft>', ...)` for line edits or whole-body rewrites; explicit "do NOT propose writes to other paths" guardrail. Banner refreshes on `active-leaf-change`. Zero new tools; existing `patch_note` does the work. 1031 tests (+4). Earlier today (v1.3.1): Phase 10 polish slice 1 (README rewrite, CSS gaps, fundingUrl, Phase 11 release-prep docs in `docs/RELEASE_CHECKLIST.md` + `docs/COMMUNITY_PLUGIN_SUBMISSION.md`). README rewritten to reflect v1.3.0 capabilities (was stale at v0.2.5; now covers all 8 phases with Install/Setup/Daily commands/Memory cascade/MCP bridge/Drafting workflow/Phase map sections). styles.css gained classes for the drafts side panel (`.sagittarius-drafts*`), the chat-response memory footer (`.sagittarius-meta-memory`), and status bar pills (`.sagittarius-status-bar`). manifest.json `fundingUrl` set to GitHub Sponsors. No code changes; 1027 tests still pass. Phase 11 release prep (signed tag, GitHub release artifacts, community-registry submission draft) follows in this same session. Phase 9 MVP shipped earlier today at v1.3.0 (ADR-029). New `src/memory/` package: `MemoryCascade.ts` (pure — `collectMemory`, `candidateCascadePaths`, `formatMemoryPromptText`, `formatMemoryFooter`; root + every ancestor folder of the active file per D2; soft-truncate at 50KB per D4), `LiveMemoryProvider.ts` (plugin-side `MemoryProvider` impl reading the workspace's active file per turn per D6, with `preview()` for UI without polluting `lastResult`). `ConduitAgent` gains an optional `memoryProvider` dep; `buildSystemPrompt` inserts the memory block between constitution and hangarVoice with its own `cache_control: ephemeral` breakpoint per D5 so CLAUDE.md edits don't invalidate the constitution cache. Provider errors degrade to "no memory" rather than failing the turn. Status bar pill ("memory: 2.1KB" / "memory: none" / "memory: off") click opens a preview modal listing the cascade. ChatView response footer gains a memory line ("memory: 2.1KB from CLAUDE.md, 30-Projects/CLAUDE.md") via the provider's `lastResult`. Two new settings: `memoryEnabled` (default true), `memoryMaxBytes` (default 50_000). **Zero new write tools** — agent proposes memory edits via existing `append_to_note` / `patch_note` per ADR-029 D8 (echoes ADR-028 lesson 2). 1027 tests (+34). Phase 9 stays open at v1.3.0; close (ADR-???) lands as a later v1.3.x after the cascade is exercised in real use. Phase 8 closed yesterday (ADR-028). Generative drafting MVP + drafts management panel ship together. `Sagittarius: New draft` → `NewDraftModal` → retrieval-grounded `AnthropicDraftingEngine` → `create_note` via the existing diff card → file lands at `_drafts/<destination>/<slug>.md` with inline `[[]]` citations + `cited_chunks: [...]` frontmatter. New `DraftsView` right-rail side panel lists every file under `_drafts/` with Open/Promote/Discard buttons; new status bar pill ("Sagittarius: N drafts") hides when empty. `Sagittarius: Promote draft` strips the `_drafts/` prefix via `move_note`. Three new settings: `draftingModel` (Opus 4.7 default per D4), `citationPolicy` (`marked` default per D3 — uncited prose wrapped in `<!-- uncited -->` comments), `draftsDefaultDestination` (`10-Inbox` default). **Zero new write tools, zero new diff-card variants, zero new transaction shapes** — Phase 8 composes existing primitives per D9 (a). 993 tests (+62 since Phase 6.7 close). ChatView Draft mode (D5 (d) + D6 (c)) deferred to v1.2.x patch. Phase 8 done; Phase 9 (memory layer) is next. The MCP bridge now exposes 5 read tools always, 9 write tools when `mcpWriteEnabled`, plus `delete_note` behind a second toggle. The diff-card-focus problem (deferred by ADR-023 lesson 2 → solved + closed ~24 h later) is fully solved for the user-not-at-Obsidian case via `ExternalProposalQueue` + side panel + status bar pill + native OS `Notification`. McpHandler races `registry.execute` against `mcpWriteQueueTimeoutMs` (default 30 s); on timeout the MCP response returns `queued` while the underlying tool keeps running and commits when the user approves later. ADR-025 OQ1 settled: side-panel Approve resolves directly (inline diff preview makes a re-opened modal redundant). The in-app-chat-concurrent case returns "retry shortly" — accepted limitation per ADR-027 lesson 2. 931 tests. Phase 6.7 done; ADR-026 (Phase 8 — generative layer) MVP at v1.2.0 is next.
- **Build pattern:** `pair-via-claude-code` per [`docs/2026-05-04-sagittarius-build-process.md`](docs/2026-05-04-sagittarius-build-process.md) (ADR-010). Thad decides; Claude implements.

## Read first (in this order)

1. [`docs/2026-05-14-adr-029-phase-9-memory-plan.md`](docs/2026-05-14-adr-029-phase-9-memory-plan.md) — ADR-029, Phase 9 plan (memory layer; 10 decisions, all accepted; 3 OQs open).
2. [`docs/2026-05-14-phase-8-close.md`](docs/2026-05-14-phase-8-close.md) — ADR-028, Phase 8 retrospective (two lessons; drafting MVP + drafts panel shipped).
3. [`docs/2026-05-14-phase-6.7-close.md`](docs/2026-05-14-phase-6.7-close.md) — ADR-027, Phase 6.7 retrospective (two lessons; diff-card-focus problem solved).
4. [`docs/2026-05-14-adr-025-phase-6.7-mcp-write-side-plan.md`](docs/2026-05-14-adr-025-phase-6.7-mcp-write-side-plan.md) — ADR-025, Phase 6.7 MCP write-side plan (10 decisions, all accepted; OQ1 settled in implementation).
5. [`docs/2026-05-14-adr-026-phase-8-generative-layer-plan.md`](docs/2026-05-14-adr-026-phase-8-generative-layer-plan.md) — ADR-026, Phase 8 generative layer plan (10 decisions, all accepted; OQ1-OQ3 deferred to v1.2.x).
6. [`docs/2026-05-14-phase-7-close.md`](docs/2026-05-14-phase-7-close.md) — ADR-024, Phase 7 retrospective (two lessons; first v1.x release).
7. [`docs/2026-05-14-phase-6.5-close.md`](docs/2026-05-14-phase-6.5-close.md) — ADR-023, Phase 6.5 retrospective (two lessons + write-side-deferred).
8. [`docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md`](docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md) — ADR-021, Phase 6.5 plan (MCP bridge; 9 decisions, all accepted).
9. [`docs/2026-05-13-adr-022-phase-7-curator-plan.md`](docs/2026-05-13-adr-022-phase-7-curator-plan.md) — ADR-022, Phase 7 plan (Curator; 10 decisions, all accepted).
10. [`docs/2026-05-13-phase-6-close.md`](docs/2026-05-13-phase-6-close.md) — ADR-020, Phase 6 retrospective.
11. [`docs/2026-05-12-adr-019-phase-6-plan.md`](docs/2026-05-12-adr-019-phase-6-plan.md) — ADR-019, Phase 6 plan (Activity Stream; MCP bridge split out, now ADR-021).
12. [`docs/2026-05-12-phase-5-close.md`](docs/2026-05-12-phase-5-close.md) — ADR-018, Phase 5 retrospective.
13. [`docs/2026-05-11-adr-017-phase-5-plan.md`](docs/2026-05-11-adr-017-phase-5-plan.md) — ADR-017, Phase 5 plan.
14. [`docs/2026-05-10-adr-016-phase-4-plan.md`](docs/2026-05-10-adr-016-phase-4-plan.md) — ADR-016, Phase 4 plan (D1-D6 + prereqs).
15. [`docs/2026-05-09-phase-3-close.md`](docs/2026-05-09-phase-3-close.md) — ADR-014, Phase 3 retrospective.
16. [`docs/2026-05-10-adr-015-vault-adapter-audit.md`](docs/2026-05-10-adr-015-vault-adapter-audit.md) — ADR-015, VaultAdapter audit findings + Phase 4 prereqs.
17. [`docs/02_SPEC.md`](docs/02_SPEC.md) — v0.1 spec (binding).
18. [`docs/03_PACKAGE_JSON.md`](docs/03_PACKAGE_JSON.md) — dependency rationale.
19. [`docs/04_MANIFEST_JSON.md`](docs/04_MANIFEST_JSON.md) — Obsidian manifest fields.
20. [`docs/05_CONDUIT_AGENT_SKETCH.md`](docs/05_CONDUIT_AGENT_SKETCH.md) — agent class shape.
21. [`docs/2026-05-04-sagittarius-build-process.md`](docs/2026-05-04-sagittarius-build-process.md) — ADR-010 (process).
22. [`docs/embed_interface.md`](docs/embed_interface.md) — embedding contract v1 (shared with corpus-ingest).
23. [`docs/THAD_MAN.md`](docs/THAD_MAN.md) — vault constitution; loaded into the agent's system prompt at runtime.
24. [`docs/concierge.md`](docs/concierge.md) — Hangar voice; loaded into the agent's system prompt.

## Decision authority hierarchy

When unsure (per ADR-010 §4):

1. Match against `docs/02_SPEC.md` + ADR-007 + ADR-009 + ADR-010 + the embedding contract → proceed.
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
| 1 — Spec | `docs/02_SPEC.md` etc. | done (in vault, mirrored to `docs/`) |
| 2 — Scaffold | esbuild, manifest, plugin entry | done |
| 3 — Read layer | side panel, retrieval, tools, budget — **= v0.1 ship (shipped as v0.2.3)** | done |
| 4 — Write layer | diff-first writes, transaction log, undo | **done (v0.3.0 MVP → v0.5.0 close; ADR-016)** |
| 5 — Organization engine | auto-routing, MOC maintenance | done (v0.6.0 MVP → v0.7.0 close; ADR-017, ADR-018) |
| 6 — Activity stream | events log, diagnostics, digest | done (v0.8.0 MVP → v0.8.2 close; ADR-019, ADR-020) |
| 6.5 — MCP bridge | expose Sagittarius tools over Model Context Protocol | done (v0.9.0 MVP → v0.9.2 close; ADR-021, ADR-023) |
| 7 — Curator | proactive vault hygiene (broken links, orphans, stale, schema, duplicate, tag-normalize) | done (v1.0.0 MVP → v1.0.3 close; ADR-022, ADR-024) |
| 6.7 — MCP write-side | expose write tools, gates, queue + side panel, OS notifications | done (v1.0.8 substrate → v1.0.9 exposure → v1.1.0 close; ADR-025, ADR-027) |
| 8 — Generative layer | cited drafts, proposal quarantine, drafts panel | done (v1.1.1 MVP → v1.2.0 close; ADR-026, ADR-028) |
| 9 — Memory layer | CLAUDE.md cascade (vault-root + ancestor folders) injected into system prompt; status bar + footer surfaces | MVP done (v1.3.0; ADR-029) — close TBD as v1.3.x |
| 10 — Polish | commands, hotkeys, screenshots | future |
| 11 — Release | tag, sign, BRAT-list, registry — **= v1.0** | future |

## Scope of this repo

- **In scope:** TypeScript plugin code, tests, build/CI, docs.
- **Out of scope:** vault content (lives in the operator's private `gengyveusa/my-obsidian-vault`), spec amendments without an ADR, architectural pivots, auto-merging your own PRs, adding deps not listed in `docs/03_PACKAGE_JSON.md` without surfacing rationale.

## How to say "I don't know"

> Spec gap: `<what>`. My best guess: `<X>`. Risk if wrong: `<Y>`. Should I proceed with `<X>` or wait for your call?
