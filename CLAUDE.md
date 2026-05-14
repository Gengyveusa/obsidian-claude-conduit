# CLAUDE.md — agent shim for `obsidian-claude-conduit`

This file orients a Claude Code session opened against this repo. Substrate questions ("what's the spec? what tools? what schema?") defer to `docs/`.

## Repo identity

- **Name:** Sagittarius — Claude Conduit (`obsidian-claude-conduit`)
- **What:** Native Obsidian plugin. Chat with your vault, retrieval-grounded.
- **Status:** v0.9.2 — Phase 6.5 MCP bridge closed (read-only, bearer-auth, localhost). Five tools exposed via JSON-RPC. Retrospective in ADR-023. Phase 7 (Curator) in flight: 5 of 7 PRs landed — four pure-rule detectors (broken-link, orphan, missing-frontmatter, stale-note) + first LLM-judged rule (duplicate-candidate). Remaining for Phase 7: TagNormalizeRule + main.ts wiring for LLM judges (v1.0.2 PR 2), skip-pattern learning + scheduled sweep + retrospective (v1.0.3 close).
- **Build pattern:** `pair-via-claude-code` per [`docs/2026-05-04-sagittarius-build-process.md`](docs/2026-05-04-sagittarius-build-process.md) (ADR-010). Thad decides; Claude implements.

## Read first (in this order)

1. [`docs/2026-05-14-phase-6.5-close.md`](docs/2026-05-14-phase-6.5-close.md) — ADR-023, Phase 6.5 retrospective (two lessons + write-side-deferred decision).
2. [`docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md`](docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md) — ADR-021, Phase 6.5 plan (MCP bridge; 9 decisions, all accepted).
3. [`docs/2026-05-13-adr-022-phase-7-curator-plan.md`](docs/2026-05-13-adr-022-phase-7-curator-plan.md) — ADR-022, Phase 7 plan (Curator; 10 decisions, all accepted; v1.0.x milestone).
4. [`docs/2026-05-13-phase-6-close.md`](docs/2026-05-13-phase-6-close.md) — ADR-020, Phase 6 retrospective (two lessons + Phase 7 follow-ups).
5. [`docs/2026-05-12-adr-019-phase-6-plan.md`](docs/2026-05-12-adr-019-phase-6-plan.md) — ADR-019, Phase 6 plan (Activity Stream; MCP bridge split out, now ADR-021).
6. [`docs/2026-05-12-phase-5-close.md`](docs/2026-05-12-phase-5-close.md) — ADR-018, Phase 5 retrospective.
7. [`docs/2026-05-11-adr-017-phase-5-plan.md`](docs/2026-05-11-adr-017-phase-5-plan.md) — ADR-017, Phase 5 plan.
8. [`docs/2026-05-10-adr-016-phase-4-plan.md`](docs/2026-05-10-adr-016-phase-4-plan.md) — ADR-016, Phase 4 plan (D1-D6 + prereqs).
9. [`docs/2026-05-09-phase-3-close.md`](docs/2026-05-09-phase-3-close.md) — ADR-014, Phase 3 retrospective.
10. [`docs/2026-05-10-adr-015-vault-adapter-audit.md`](docs/2026-05-10-adr-015-vault-adapter-audit.md) — ADR-015, VaultAdapter audit findings + Phase 4 prereqs.
11. [`docs/02_SPEC.md`](docs/02_SPEC.md) — v0.1 spec (binding).
12. [`docs/03_PACKAGE_JSON.md`](docs/03_PACKAGE_JSON.md) — dependency rationale.
13. [`docs/04_MANIFEST_JSON.md`](docs/04_MANIFEST_JSON.md) — Obsidian manifest fields.
14. [`docs/05_CONDUIT_AGENT_SKETCH.md`](docs/05_CONDUIT_AGENT_SKETCH.md) — agent class shape.
15. [`docs/2026-05-04-sagittarius-build-process.md`](docs/2026-05-04-sagittarius-build-process.md) — ADR-010 (process).
16. [`docs/embed_interface.md`](docs/embed_interface.md) — embedding contract v1 (shared with corpus-ingest).
17. [`docs/THAD_MAN.md`](docs/THAD_MAN.md) — vault constitution; loaded into the agent's system prompt at runtime.
18. [`docs/concierge.md`](docs/concierge.md) — Hangar voice; loaded into the agent's system prompt.

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
| 7 — Curator | proactive vault hygiene (broken links, orphans, stale, schema) | planned (v1.0.0 MVP → v1.0.3 close; ADR-022) |
| 8 — Generative layer | cited drafts, proposal quarantine | future |
| 9 — Memory layer | CLAUDE.md reader/writer, dossiers | future |
| 10 — Polish | commands, hotkeys, screenshots | future |
| 11 — Release | tag, sign, BRAT-list, registry — **= v1.0** | future |

## Scope of this repo

- **In scope:** TypeScript plugin code, tests, build/CI, docs.
- **Out of scope:** vault content (lives in the operator's private `gengyveusa/my-obsidian-vault`), spec amendments without an ADR, architectural pivots, auto-merging your own PRs, adding deps not listed in `docs/03_PACKAGE_JSON.md` without surfacing rationale.

## How to say "I don't know"

> Spec gap: `<what>`. My best guess: `<X>`. Risk if wrong: `<Y>`. Should I proceed with `<X>` or wait for your call?
