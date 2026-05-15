# Changelog

Versioning is semver-ish: minor bumps signal new user-facing capability,
patch bumps are polish + bug fixes within a phase. Each phase has a plan
ADR (numbered) and a close ADR (retrospective) — see `docs/`.

## [1.3.1] — 2026-05-15 (Phase 10 polish)

- README full rewrite — covers all 8 shipped phases (was stale at v0.2.5)
- styles.css — added classes for the drafts panel, memory footer, status bar pills
- manifest.json — `fundingUrl` set to GitHub Sponsors

## [1.3.0] — 2026-05-14 (Phase 9 MVP — ADR-029)

- **CLAUDE.md cascade.** Vault-root + every ancestor folder of the active file loads into the system prompt every chat turn.
- 50KB budget, soft-truncates at the cap (configurable).
- Status bar pill ("memory: 2.1KB") + click-preview modal.
- ChatView response footer reports what loaded.
- Settings: `memoryEnabled`, `memoryMaxBytes`.
- **Zero new write tools** — agent proposes memory edits via existing `append_to_note` / `patch_note`.
- Tests: +34 (1027 total).

## [1.2.0] — 2026-05-14 (Phase 8 close — ADR-028)

- **Drafts side panel.** Lists every file under `_drafts/` with Open / Promote / Discard.
- Status bar pill ("Sagittarius: N drafts") hides when empty.
- Live re-render on vault create/modify/delete/rename.
- Phase 8 retrospective ADR with two carry-forward lessons.

## [1.1.1] — 2026-05-14 (Phase 8 MVP — ADR-026)

- **`Sagittarius: New draft`** + topic modal → retrieval-grounded cited drafts.
- `_drafts/<destination>/<slug>.md` quarantine; promotion via `move_note`.
- Inline `[[note-path]]` citations + `cited_chunks: [...]` frontmatter.
- Three citation policies: strict / marked (default) / free.
- Settings: `draftingModel`, `citationPolicy`, `draftsDefaultDestination`.

## [1.1.0] — 2026-05-14 (Phase 6.7 close — ADR-027)

- MCP write-side fully ships: 9 write tools when enabled, `delete_note` behind a second toggle.
- `ExternalProposalQueue` + side panel + status pill + native OS notifications solve the diff-card-focus problem for the user-not-at-Obsidian case.
- `mcpWriteQueueTimeoutMs` (default 30s) — McpHandler races `registry.execute`; on timeout returns `queued` and the underlying tool commits when approved.

## [1.0.x] — 2026-05-14 (Phase 7 — ADR-022 / ADR-024)

- **Curator** — proactive vault hygiene: broken links, orphans, stale notes, schema violations, duplicate candidates, tag normalization.
- Skip-pattern store so dismissed suggestions stop nagging.

## [0.9.x] — 2026-05-13 (Phase 6.5 — ADR-021 / ADR-023)

- **MCP bridge (read-side)** — Sagittarius's 5 read tools exposed via Model Context Protocol so Claude Desktop can query the vault from outside Obsidian.

## [0.8.x] — 2026-05-12 (Phase 6 — ADR-019 / ADR-020)

- **Activity stream** — every event (chat, write, suggestion, MCP call) lands in a side panel with filtering + diagnostics + digest.

## [0.6.0–0.7.0] — 2026-05-11 (Phase 5 — ADR-017 / ADR-018)

- **Organization engine** — auto-routing of inbox notes; MOC maintenance.
- Suggestions side panel with Apply / Skip per item.

## [0.3.0–0.5.0] — 2026-05-10 (Phase 4 — ADR-016)

- **Diff-first writes.** All vault writes route through the diff card (ADR-016 D2 — the load-bearing constraint that makes every later phase's primitive-reuse possible).
- Transaction log + undo.
- 9 write tools: `create_note`, `append_to_note`, `patch_note`, `rewrite_section`, `move_note`, `rename_note`, `delete_note`, `add_frontmatter`, `link_notes`.

## [0.2.x] — 2026-05-09 (Phase 3 close — ADR-014)

- **Read layer ships:** side panel chat, Cmd+P quick question, 5 read tools (`read_note`, `list_folder`, `search_vault`, `get_backlinks`, `get_graph_neighborhood`).
- Semantic retrieval via HuggingFace inference SDK.
- Daily token + dollar budget caps.

## [0.1.x] — 2026-05-04 (Phases 1–2)

- Spec, scaffold, manifest, plugin entry.
