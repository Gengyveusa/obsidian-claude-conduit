# Changelog

Versioning is semver-ish: minor bumps signal new user-facing capability,
patch bumps are polish + bug fixes within a phase. Each phase has a plan
ADR (numbered) and a close ADR (retrospective) — see `docs/`.

## [1.4.0] — 2026-05-15 (Proactive draft suggestions — ADR-026 D8(b))

- **`Sagittarius: Suggest drafts`** — new command. Scans the vault for tags shared by N+ notes that lack a synthesis; surfaces a modal with one row per candidate and a "Draft this" button.
- New `src/curator/rules/DraftSuggestionRule.ts` — pure rule per ADR-024 lesson 2. `buildTagCensus(corpus)` collects tag membership + flags synthesis notes; `makeDraftSuggestionRule({ minNotes, ignoreTags })` filters to clusters lacking synthesis.
- "Synthesis" detection: `type: synthesis` frontmatter OR filename containing "synthesis"/"summary"/"overview".
- Default ignore-tags: `inbox`, `draft`, `wip`, `synthesis`, `moc`, `index`, `archive` (structural tags shouldn't trigger suggestions).
- `NewDraftModal` gained an optional pre-fill (`initialTopic`) for "Draft this" → modal opens with topic already typed.
- Severity scales with cluster size (5 → 0.5; 20+ → 1.0 capped).
- New setting: `draftSuggestionMinNotes` (default 5).
- Standalone command (not yet wired into curator orchestrator); full integration deferred to v1.4.x once the suggestion shape stabilizes.
- Tests: +13 (1063 total).

## [1.3.4] — 2026-05-15 (Citation drift verification at promotion)

- **Pre-promotion citation drift check.** Before `Sagittarius: Promote draft` fires the `move_note`, every `cited_chunks` entry is verified against the current retrieval index.
- Two classes of drift: **missing chunks** (note exists but chunk index gone — usually rechunked) and **missing notes** (source note deleted/moved/never indexed).
- On drift: a confirmation modal lists every drifted citation; operator can "Promote anyway" (citations are documentation, not contracts) or cancel.
- Drift-check failure (e.g., engine unavailable) logs a warning and proceeds — never blocks promotion.
- New `src/drafts/citationDrift.ts`: pure `verifyCitations(opts)` + `formatDriftSummary(report)`.
- Tests: +11 (1050 total).

## [1.3.3] — 2026-05-15 (Drafting engine reads CLAUDE.md cascade)

- **`AnthropicDraftingEngine` reads memory.** New optional `memoryProvider` dep; when set, the cascade text appears as a `# Operator memory` block between persona and output-format in the drafting system prompt.
- Same provider instance ChatView uses; cascade anchors on the active file at the moment New Draft is invoked.
- Provider errors degrade to "no memory" (warn-log only, draft doesn't fail) — mirrors `ConduitAgent`'s contract.
- House-style + project conventions in `CLAUDE.md` now reach generative output, not just chat.
- Tests: +8 (1039 total).

## [1.3.2] — 2026-05-15 (ChatView Draft mode — ADR-026 D5(d)+D6(c))

- **ChatView Draft mode.** When the active file is under `_drafts/`, ChatView shows a "Refining draft: …" banner and the agent's system prompt scopes edits to that file via `patch_note`.
- Banner refreshes on `active-leaf-change`; opening a non-draft file exits draft mode.
- `ConduitAgent.chat()` gains an optional `draftPath` 5th positional param; when set, a "Mode: DRAFT REFINE" block is appended to the system prompt with explicit `patch_note` guidance.
- Zero new tools; existing `patch_note` does the work.
- Tests: +4 (1031 total).

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
