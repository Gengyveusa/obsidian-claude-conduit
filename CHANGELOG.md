# Changelog

Versioning is semver-ish: minor bumps signal new user-facing capability,
patch bumps are polish + bug fixes within a phase. Each phase has a plan
ADR (numbered) and a close ADR (retrospective) — see `docs/`.

## [1.9.0] — 2026-05-18 (Phase 16 session 1 — time-travel substrate — ADR-037)

- **Schema migration**: chunks table gains nullable `commit_sha` column + supporting index. Non-breaking — existing chunks keep `commit_sha = NULL` (current state); schema_version stays at `1` (per ADR-037 D5 — additive change, no rebuild needed).
- **`src/timetravel/git.ts`** — pure helpers (`readHeadSha`, `resolveRefFromPackedRefs`, `vaultHasGit`) that read git history via the existing `VaultAdapter` (no subprocess, no `git` CLI). Supports loose-ref + packed-refs resolution, detached HEAD, lowercase-normalized output, graceful `null` returns when git isn't present.
- **`Sagittarius: Snapshot vault for time-travel`** command stub — validates `timeTravelEnabled` + git presence, resolves HEAD SHA, surfaces a Notice. Actual chunk snapshotting (writing chunks with `commit_sha = <HEAD>`) lands in session 2.
- 2 new settings: `timeTravelEnabled` (opt-in, default false per ADR-037 D1), `timeTravelRetentionDays` (365 per D4).
- **Sessions 2 + 3 deferred**: ChatView `time-travel` mode + snapshot picker modal + write-blocking + banner + citation date-suffix + GC + tests for the integration path.
- Tests: +15 (1193 total).

## [1.8.0] — 2026-05-18 (Phase 15 MVP — Negotiation mode — ADR-036)

- **New chat mode `Negotiate`** joins `Chat` and `Vault QA` in the ChatView dropdown. When selected, agent flips to adversarial posture: finds the strongest counter-evidence to the operator's thesis from their own vault notes.
- **System prompt addendum** explicitly forbids softening and sycophancy; mandates `[[note-path]]` citations for every counter; honest fallback when the vault contains no counter-evidence ("the thesis may be uncontested in your written record — which is itself worth noting").
- **Pre-retrieval fires** for negotiate mode just like vault-qa (per ADR-036 D6) — agent needs vault context as raw material for the counter-search.
- **⚔ banner** above messages area signals adversarial posture is active.
- Zero new write tools, zero new settings. Negotiate is transient ChatView state per ADR-036 D8.
- **Eighth phase of "zero new write tools" in a row.**
- Tests: +6 (1178 total).

## [1.7.0] — 2026-05-18 (Phase 14 MVP — Daily briefing — ADR-035)

- **`Sagittarius: Generate today's briefing`** — new command. Aggregates curator + activity + drafts + synthesis opportunities + memory state + journal "open threads" into one scannable digest written to `_briefings/<YYYY-MM-DD>.md` via the existing diff card.
- **First-launch-of-the-day scheduler** — when `briefingEnabled` is on and today's briefing doesn't exist yet, generation fires automatically on plugin load. Per-day idempotency via `briefingLastDay` settings field.
- **Six fixed sections** per ADR-035 D3: What changed yesterday / Curator suggestions / Drafting backlog / Synthesis opportunities / Memory state / Open threads from journals.
- **Severity-sorted curator findings** with emoji badges (🔴 / 🟠 / 🟡 / ⚪).
- New `src/briefing/` package: `paths.ts` (paths + date extraction), `BriefingComposer.ts` (pure renderer), `journalThreads.ts` (pulls "Open threads:" bullets from recent journals).
- 3 new settings: `briefingEnabled` (opt-in, default false per ADR-024 lesson 1), `briefingMaxItemsPerSection` (default 10), `briefingLastDay` (idempotency state — operator never sets).
- **Zero new write tools** — composes existing `create_note`. **Seven phases of this discipline in a row.**
- Editorial summary (D4) + status bar pill (D6) deferred to v1.7.1.
- Tests: +32 (1172 total).

## [1.6.0] — 2026-05-16 (Phase 13 MVP — Conversational notes — ADR-034)

- **`Sagittarius: Save this conversation as a note`** — new command. Reads ChatView history (Phase 12 substrate), renders a Q&A markdown note with H2 headers per turn, proposes `create_note('_chats/<YYYY-MM-DD>/<slug>.md', content)` via the existing diff card.
- Citations in assistant turns stay as `[[]]` wikilinks; Obsidian's metadata cache builds backlinks automatically — chat note becomes a hub for the conversation's source material.
- Frontmatter: `type: chat` + `session_id` + dates + `mode` + `turn_count` + optional tokens/cost + `cited_chunks` mirroring drafting (citation-drift verifier reuses for free).
- Collision handling: if today's slug already exists, `chatPathWithSuffix` adds `-2`, `-3` etc.
- New `src/chats/paths.ts` (pure helpers): `slugifyChat`, `chatNotePathFor`, `isChatNotePath`, `chatPathWithSuffix`.
- New `src/chats/ChatNoteWriter.ts`: `renderChatNote` pure renderer; extracts cited paths from inline wikilinks.
- 1 new setting: `chatNotesEnabled` (opt-in, default false per ADR-034 D7).
- **Zero new write tools** — composes existing `create_note` per ADR-016 D2 + ADR-028 lesson 2 (six phases of this discipline now).
- v1.6.x slots: ChatView header button (v1.6.1), per-conversation opt-out toggle (v1.6.1), auto-save options, chat-notes side panel, "Replay this conversation" command.
- Tests: +22 (1140 total).

## [1.5.0] — 2026-05-15 (Phase 12 MVP — Reverse-memory journal — ADR-033)

- **`Sagittarius: Journal this session`** — new command. Agent reads recent ChatView history, summarizes into a four-bullet H2 entry (Worked on / Decided / Learned about operator / Open threads), proposes `append_to_note('_memory/<YYYY-MM-DD>.md', entry)` via the existing diff card.
- **Cascade integration:** `LiveMemoryProvider` now reads the most-recent N journal files and prepends them ABOVE the CLAUDE.md cascade in the system prompt. Default `journalCascadeDays = 3`.
- New `src/memory/journal.ts` (pure helpers): `journalPathFor`, `isJournalPath`, `formatJournalSection`, `listRecentJournals`, `formatJournalCascade`.
- New `src/memory/JournalGenerator.ts`: `AnthropicJournalGenerator` drives the model with a tight system prompt that mandates the four-bullet format + forbids sycophancy in "Learned about operator" bullets.
- New `ChatView.recentHistory()` — read-only snapshot of in-memory chat history.
- 3 new settings: `journalEnabled` (default false — opt-in per ADR-033 D7), `journalCascadeDays` (3), `journalModel` (Sonnet default).
- **Zero new write tools** — composes existing `append_to_note` / `create_note` per ADR-016 D2 + ADR-028 lesson 2.
- 4 named v1.5.x follow-up slots: auto-trigger, retention policy, per-conversation delta journal, journals side panel.
- Tests: +24 (1118 total).

## [1.4.2] — 2026-05-15 (Per-client MCP token slots — ADR-032)

- **Named per-client MCP tokens.** The single shared `mcpToken` becomes an array of `mcpTokens`, each entry with a name (`claude-desktop`, `cursor`, `cline`), scope (`read` / `write` / `delete`), and independent revocation.
- Generate via Settings → Sagittarius → MCP bridge → Generate; raw token shown once via Notice.
- Revoke per-row from the tokens table.
- Scope semantics (ADR-032 D2): `read` = 5 read tools only; `write` adds 9 write tools; `delete` adds `delete_note`. Strict supersets.
- Global `mcpWriteEnabled` / `mcpHighRiskToolsEnabled` toggles become circuit-breakers per ADR-032 D3 — they cap whatever a scope can do.
- External Proposals + activity log surface the **token name** (operator-verified) rather than the client-supplied `clientInfo.name`.
- Migration (ADR-032 D10): existing single-token installs auto-migrate to a `legacy` entry on first plugin load; scope derived from current global toggles.
- New helpers in `src/mcp/tokens.ts`: `lookupBearerToken`, `authenticateBearerHeader`, `migrateLegacyToken`, `validateTokenName`, `scopeAllows`.
- Tests: +31 (1094 total).

## [1.4.1] — 2026-05-15 (Submission-prep: action-based description)

- `manifest.json` description rewritten action-first per current Obsidian submission style guide ("Chat with your vault using Claude…" instead of "Native Obsidian plugin for Claude…").
- `docs/COMMUNITY_PLUGIN_SUBMISSION.md` checklist updated to reflect current docs (older "no 'plugin'/no 'Obsidian'" rules were inaccurate; current rule is action-based opening + ≤250 chars + period + no emoji).
- No code changes; tests unchanged at 1063.

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
