---
title: "ADR-010: Sagittarius v0.1 Build Process — Thad + Claude Pair via Claude Code"
type: decision
status: "Accepted"
date: 2026-05-04
created: 2026-05-04
updated: 2026-05-04
deciders: [Thad]
supersedes:
superseded-by:
tags: [decision, ADR, sagittarius, build-process, pair-programming, thad-man]
---

# ADR-010: Sagittarius v0.1 Build Process — Thad + Claude Pair via Claude Code

> **Pattern name:** `pair-via-claude-code` — Thad as product owner + decision authority; Claude as engineering pair via Claude Code sessions on a separate plugin repo. This ADR makes the pattern explicit so future sessions (and other Claude instances) operate consistently.

## Context

[[20-Decisions/2026-05-04-sagittarius-build-commitment|ADR-009 Q1]] answered "who builds Sagittarius?" with **"me and you"** — Thad + Claude. That's a model that didn't appear in my original four-option enumeration (solo / contractor / co-founder / OSS). It deserves its own ADR because:

1. The model has implications for repo structure, session sequencing, decision authority, and review discipline that aren't obvious from "Thad + Claude" as a label.
2. Future Claude sessions need to know the protocol so they don't re-invent it (or violate it).
3. Other vault systems may eventually adopt the same pattern; documenting it once means it's reusable.

The alternative — start coding without this ADR — risks each session re-litigating the basics. Save the litigation for the architecture, not the workflow.

## Decision

### 1. Roles

| Role | Owned by | Specifically |
|---|---|---|
| **Product owner** | Thad | Decides what's in/out of v0.1, what counts as done, when to ship, when to defer features |
| **Architect** | Thad (with Claude as advisor) | Decides design tradeoffs at the load-bearing level (tool signatures, data model, API contracts) |
| **Implementer** | Claude (via Claude Code) | Writes TypeScript, tests, build/CI config, documentation |
| **Reviewer** | Thad | Reviews every PR before merge; catches design + implementation errors |
| **Deployer** | Thad | Hand on the trigger for releases (v0.1, v0.5, v1.0) |
| **Tester** | Both | Thad does real-vault smoke tests; Claude writes unit + integration tests against fixture vault |

**Critical boundary:** Claude proposes; Thad decides. Same discipline as the [[21-Agents/thad-man-curator|Curator skill spec]] — drafts only, never auto-files. PRs are Thad's hand on the trigger.

### 2. Where the work lives

| What | Where | Why |
|---|---|---|
| Plugin code (TypeScript) | `gengyveusa/obsidian-claude-conduit` (separate repo, MIT, public) | Per ADR-009 §4 |
| Spec + ADRs + doctrine | `gengyveusa/my-obsidian-vault` → `18-Obsidian-Claude-Plugin/` + `20-Decisions/` | Source of truth for design intent |
| `CLAUDE.md` for the plugin repo | `gengyveusa/obsidian-claude-conduit/CLAUDE.md` (created in Phase 2) | Per-repo agent shim; references back to vault for substrate questions |
| Build artifacts (compiled `main.js`, `manifest.json`) | Plugin repo, on releases | Ships to BRAT and (eventually) `obsidianmd/obsidian-releases` |
| Real-vault testing | This vault (`gengyveusa/my-obsidian-vault`) | The dogfooding ground; Thad's personal Sagittarius install reads/writes here |

### 3. Session protocol

A "build session" is a bounded unit of pair-mode work. Protocol:

#### Pre-session (Thad)
1. Decide what phase / sub-phase to work on. Reference [[20-Decisions/2026-05-04-sagittarius-build-commitment|ADR-009 §"How sessions sequence"]] for the milestone framework.
2. Open Claude Code in the plugin repo's working directory.
3. Initial prompt to Claude: *"We're working on `<repo>/<phase>` from killer prompt §X. Here's what we did last session: `<brief>`. Today's goal: `<scope>`."*

#### During-session (Claude)
1. Read the relevant context: killer prompt §X, the relevant ADRs, recent git log, last session's `01_SPEC.md` updates.
2. Confirm the goal in one sentence.
3. Propose a plan (TodoWrite) before writing code.
4. Implement in small commits. Each commit is one logical unit (e.g., "add `read_note` tool with input schema and tests").
5. Update `CLAUDE.md` in the plugin repo when something architectural lands.
6. End the session with a single PR. Tag it `phase/<N>` with a short description.

#### Post-session (Thad)
1. Review the PR. Code + tests + docs.
2. **Merge** if clean. **Comment** if needs changes (Claude addresses in next session). **Close** if direction was wrong.
3. Optionally: open a new issue with what's next.

#### Handoff to next session
Each session reads:
- Last merged PR's description
- Relevant `CLAUDE.md` entries
- Any open issues from the prior review

This is essentially the same discipline this very vault session has been operating under.

### 4. Decision authority hierarchy

When Claude is unsure, the decision tree is:

1. **Does it match the killer prompt + ADR-007 + ADR-009 + the embedding contract?** → proceed.
2. **Is it a design extension that the spec didn't cover?** → propose in PR description, default to the *more conservative* option, flag for Thad's review.
3. **Is it a deviation from spec / ADR?** → STOP. Do not implement. Surface as a question in the PR (or as an inline comment in the relevant ADR's "open questions" section). Wait for Thad.
4. **Is it a load-bearing architectural change?** → file a new ADR draft. Do not merge until Thad accepts the ADR.

Claude does not silently make architectural decisions. The build velocity from "Claude implements while Thad reviews" depends on Thad being able to trust that the spec is honored.

### 5. Code quality gates (per killer prompt §9)

- **Types:** no `any` except at FFI boundaries with `// TODO: type` note.
- **Tests:** every tool gets a unit test; every destructive op gets an integration test against a fixture vault.
- **Errors:** every thrown error is actionable (what happened + what to try).
- **Perf:** 10k-note vault stays < 150MB RAM, indexes in < 2 min cold.
- **Docs:** every exported function gets a one-line purpose + example.
- **Observability:** structured logs to `<plugin-data>/log.ndjson`, rotated daily.

These are the bar for **every PR**, not just final phases. Tests-with-the-feature, not tests-after.

### 6. How sessions sequence

Per ADR-009 §Q4, the milestone framework is session-cadence-based, not calendar-based. Estimated session counts per phase:

| Phase | Estimated sessions | Output |
|---|---|---|
| **Phase 1 — Spec** | 1–2 | `01_SPEC.md` in plugin repo with mermaid arch diagram, data model, tool list with signatures, UI wireframes (ASCII OK), threat model |
| **Phase 2 — Scaffold** | 2–3 | Plugin loads in Obsidian, "Hello from Claude" ribbon icon, settings tab with API key + model selection, BRAT-installable, version bumping wired, basic CI |
| **Phase 3 — Read layer** | 4–6 | Chat side panel, Vault QA mode, retrieval via canonical local embedding (per [[Assets/code/corpus-ingest/parsers/embed_interface]]), context budget manager, "Why?" button — **this is v0.1** |
| **Phase 4 — Write layer** | 3–5 | Diff-first writes, transaction log, undo |
| **Phase 5 — Organization engine** | 3–5 | Auto-routing, asset custody, MOC maintenance — **this is v0.5** |
| **Phase 6 — Activity stream + alerts** | 2–3 | Event capture, notifier interface, daily digest, self-audit. Also: MCP bridge ships here per ADR-007 Q1. |
| **Phase 7 — Curator** | 2–3 | Proactive suggestion passes, ranked review docs, learn-from-dismissal — wires the [[21-Agents/thad-man-curator]] markdown skill spec into the plugin |
| **Phase 8 — Generative layer** | 2–3 | Proposal quarantine (`10-Inbox/curator-proposals/`), citation enforcement, promotion workflow, idea ledger |
| **Phase 9 — Memory layer** | 1–2 | CLAUDE.md reader/writer, folder memory, dossier generator |
| **Phase 10 — Polish** | 2–3 | Commands, hotkeys, docs, screenshots |
| **Phase 11 — Release** | 1–2 | Tag, sign, BRAT-list, submit to `obsidianmd/obsidian-releases` — **this is v1.0** |
| **Total** | ~22–35 | v1.0 community release |

**No phase has a calendar deadline.** Cadence is whatever Thad sustains.

### 7. Failure modes (named, with responses)

| Symptom | Diagnosis | Response |
|---|---|---|
| Phase stalls 3+ weeks without a session | Bandwidth gap | File [[80-Intelligence/Reflections/00_Index|reflection]] asking why. Either reschedule or re-scope; do not silently abandon. |
| PR sits >7 days without review | Review backlog | Don't open another build PR. Catch up reviews first. |
| Claude proposes architectural deviation in a PR | Spec drift | Thad: comment on PR with decision; Claude addresses next session. Do not merge. |
| Build session produces too-large PR (>~500 lines) | Scope creep mid-session | Future sessions: ship at the next clean boundary, even if mid-feature. Two PRs > one giant PR. |
| Tests fail in CI but PR is merged anyway | Discipline lapse | This is the load-bearing hygiene rule. **Do not merge red CI.** If green-CI is too slow, optimize CI before optimizing speed. |
| Anthropic API costs exceed $200/month | Higher-than-modeled session frequency | Re-estimate; possibly downshift to Sonnet for more work, reserve Opus for design sessions. |

### 8. Coordination with the existing vault session pattern

This vault session has been operating in a similar pair-mode all session — the user has been the product owner, Claude the implementer, PRs the trigger point. The Sagittarius build is the same pattern, applied to a different repo with a different domain (TypeScript plugin code vs vault doctrine).

Implication: **the Curator skill spec ([[21-Agents/thad-man-curator]]) is the prototype of Sagittarius's Phase 7.** When Phase 7 lands, the markdown skill becomes the agent prompt the plugin loads internally. Same source of truth, two consumption layers (manual paste-into-LLM today; native plugin invocation later).

### 9. Repo creation step (out of this session's scope)

This Claude Code session is **scoped to `gengyveusa/my-obsidian-vault` only.** The MCP server only exposes tools for this repo. So Thad creates the new repo manually:

```bash
gh repo create gengyveusa/obsidian-claude-conduit \
  --public \
  --license mit \
  --description "Native Obsidian plugin for Claude — chat, retrieval, diff-first writes, curator. Built on Thad Man v1 substrate."

cd ~/code  # or wherever
git clone https://github.com/gengyveusa/obsidian-claude-conduit.git
cd obsidian-claude-conduit
# ready for Phase 1
```

Once the repo exists, **a new Claude Code session** (with that repo as cwd, NOT this vault session) drives Phase 1+. This vault session continues to track ADRs, doctrine, spec evolution, and Reflections.

## Alternatives considered

### Alternative 1: Run plugin build from inside this vault session

Rejected. This session's MCP is scoped to the vault repo; can't push to a different remote, can't create branches in the plugin repo. Splitting MCP scope would require a different orchestration. Cleaner to keep the plugin build in its own session.

### Alternative 2: Build the plugin as a subdirectory of this vault repo

Rejected per [[20-Decisions/2026-05-04-sagittarius-build-commitment|ADR-009 §4]]. Plugins ship from their own repos.

### Alternative 3: Use a shared monorepo (vault + plugin + corpus-ingest + memory-mcp all together)

Rejected. Each component has its own lifecycle: vault is content + doctrine; plugin is a community-shippable artifact; corpus-ingest is a Python pipeline; memory-mcp is a server. Coupling them via monorepo makes each worse for unclear benefit.

### Alternative 4: Skip ADR-010, just start coding

Rejected. The "Thad + Claude pair" model is novel enough that named-and-documented saves re-litigation later. ~30 min of writing this ADR saves >>30 min of every future session re-asking "wait, who decides this?"

## Consequences

### Positive
- **Build process is explicit.** Future sessions follow the protocol; new Claude instances pick up the pattern from this ADR.
- **Decision authority is clear.** No ambiguity about who decides what.
- **Failure modes are named.** Stalled phases, sloppy PRs, scope creep all have named responses.
- **Cost model is sane.** ~$50–200/month API spend vs $30–50K contractor.
- **The Curator skill spec is positioned to be reused** in Phase 7 — design coherence across the four-layer stack.

### Negative / cost
- **Thad's review bandwidth is the binding constraint.** If review backlog grows, build velocity drops to zero.
- **No external accountability.** Calendar deadlines are absent by design; this could let phases drift indefinitely if Thad's attention shifts.
- **Code quality ceiling is Claude's TypeScript ceiling.** A FAANG-bar contractor would write better code in places. Mitigation: Thad's review + spec discipline.
- **Cross-session coordination relies on `CLAUDE.md` + PR descriptions + git log.** If those degrade (stale CLAUDE.md, terse PR descriptions), build sessions lose context. Mitigation: each session ends by updating `CLAUDE.md` with what changed.

### Reversible?
- **Build process** is fully reversible per session — switch to a contractor at any point if pace stalls.
- **Repo separation** is trivially reversible (git submodule into vault, or vice versa).
- **Decision authority hierarchy** is the most load-bearing piece; reversing it (e.g., Claude having merge authority) would change the system fundamentally. Don't.

## Follow-up

- [ ] **Thad creates the plugin repo:** `gh repo create gengyveusa/obsidian-claude-conduit --public --license mit`. Outside this session's scope.
- [ ] **First Phase 1 session** (in a new Claude Code session in the new repo): produce `01_SPEC.md` per killer prompt §8.1.
- [ ] **Update [[21-Agents/surfaces]]** when v0.1 ships — Sagittarius row's status flips to "(v0.1 — read-only, in production)."
- [ ] **First Reflection** after Phase 1 ships: did the protocol hold? Tune if not.
- [ ] **Curator's mechanical sweep set** gains: "if a Sagittarius phase has no session in 3 weeks, surface as a stalled-phase deficit per ADR-010 §7."

## Related

- [[20-Decisions/2026-05-04-sagittarius-build-commitment]] — ADR-009, the commitment this process operationalizes
- [[20-Decisions/2026-05-04-sagittarius-q1-q3-signoff]] — ADR-007, the architecture decisions this build implements
- [[18-Obsidian-Claude-Plugin/00_BUILDER_PROMPT]] — killer prompt §8 (deliverables) + §9 (quality gates)
- [[18-Obsidian-Claude-Plugin/01_KICKOFF]] — executor's design proposal
- [[Assets/code/corpus-ingest/parsers/embed_interface]] — embedding contract Sagittarius honors
- [[21-Agents/thad-man-curator]] — Curator skill spec, prototype of Phase 7
- [[20-Decisions/00_Index]]
