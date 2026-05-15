---
title: "ADR-031: Roadmap — Phases 12-16 (the holy-shit moves)"
type: decision
status: "Accepted (roadmap-level; per-phase plan ADRs follow)"
date: 2026-05-15
---

## Context

With v1.4.1 publicly listed in the Obsidian community plugin
registry on 2026-05-15, Sagittarius's original 11-phase roadmap is
complete. Phases 1-11 took it from spec to public release in a
calendar week; the original spec called the v1.0 milestone "= v1.0"
and we shipped v1.4.1 with 1063 tests, 8 production phases, and a
working public installation path.

**This ADR opens Phase 12.** Five new phases (12-16) target
qualitative-different capabilities beyond the read/write/draft/memory
core that's already shipped. Each one **inverts** something currently
one-directional in the architecture. Each one is the kind of thing
that changes what Sagittarius IS, not just what it does.

This is a roadmap-level ADR per the build process (ADR-010 §4): it
captures intent + ordering + version slots for all 5 phases, but does
NOT make per-decision binding choices. Each phase will get its own
plan ADR (ADR-032 → ADR-036) before implementation, with the usual
6-10 numbered decisions, batch-acceptance pattern, and same-session
implementation per ADR-026/ADR-029 precedent.

## Goals

- **Commit to the 5-phase arc** with explicit version slots so deferred
  work doesn't rot (ADR-030 lesson 1).
- **Order the phases** foundation-first so each builds on the prior
  without architectural backtracking.
- **Surface the unifying thread** so future plan ADRs stay aligned to
  the same north star.

## The unifying thread

Each of the 5 phases inverts a one-directional dependency:

| Phase | What it inverts |
|---|---|
| 12 — Reverse-memory journal | Memory: was operator → agent (Phase 9). Now also agent → vault. |
| 13 — Conversational notes | Chat history: was ephemeral log. Now durable vault content. |
| 14 — Daily briefing | Curator: was reactive (run on demand). Now proactive (morning digest). |
| 15 — Negotiation mode | Agent posture: was supportive. Now adversarial — argues against you using your own vault. |
| 16 — Time-travel queries | Retrieval index: was current-state. Now temporal (query the vault as it existed at any past commit). |

Read in order, each phase produces something the next can consume.
Reverse-memory journals become content for time-travel queries.
Conversational notes feed the daily briefing's "what changed" pane.
Negotiation mode draws from journals and conversations to surface
disconfirming evidence. Time-travel makes longitudinal self-reflection
possible across all of the above.

## Decisions

### D1. Five phases, five version slots, foundation-first ordering.

**Selected:**

| Phase | Version slot | Working title | Sized |
|---|---|---|---|
| 12 | v1.5.0 | Reverse-memory journal | Smallest — builds directly on Phase 9 cascade |
| 13 | v1.6.0 | Conversational notes | Small — inverts existing ConversationLogger |
| 14 | v1.7.0 | Daily briefing | Medium — composes curator + memory + activity + drafts |
| 15 | v1.8.0 | Negotiation mode | Medium — new chat mode + retrieval pivot |
| 16 | **v2.0.0** | Time-travel queries | Largest — git-aware index; **major** version bump |

**Why this ordering:** each phase consumes substrate from the prior
without depending on the next. Phase 12 lands a pattern (`_memory/`
session journals) that Phase 13's `_chats/` mirrors. Phase 14's
briefing aggregates outputs from 12 + 13 + earlier curator. Phase 15's
adversarial retrieval benefits from the larger journal + chat surface
the prior phases create. Phase 16 is the deepest architectural change
and rightly comes last — by then we'll have learned what queries
actually matter.

**Why v2.0.0 for Phase 16:** it changes the index from a snapshot to a
temporal artifact. That's a load-bearing architectural pivot per the
ADR-027 lesson 1 heuristic ("substrate that introduces a load-bearing
type-system change deserves its own version"). v2.0.0 also signals to
operators: this is a meaningful new capability, not a polish patch.

### D2. Each phase gets its own plan ADR before implementation.

**Selected:** ADR-032 plans Phase 12. ADR-033 plans Phase 13. And so
on. Each plan ADR follows the ADR-026/ADR-029 template: 6-10 numbered
decisions with recommended cuts; batch-acceptance pattern; OQs
deferred to v1.X.x patches.

**Why not skip to implementation:** the prior 9 phases prove the
plan-then-implement discipline pays off. Phase 8 and Phase 9 each
batch-accepted 10 decisions in <30 minutes and shipped MVPs the same
session because the cuts were already settled. Skipping the planning
step risks shipping the wrong shape.

**Each close ADR also stays binding** — Phase 12 close (ADR-???)
follows v1.5.x patches per the ADR-030 lesson 1 pattern.

### D3. Phase 12 (Reverse-memory journal) — recommended scope.

**Selected scope** (provisional; final cuts in ADR-032):

- Path: `_memory/<YYYY-MM-DD>.md` per session, appended to if multiple
  sessions per day
- Trigger: end of each `chat()` turn appends a one-line summary; a
  longer "session reflection" writes on plugin unload (or, more
  reliably, on a configurable timer)
- Cascade integration: Phase 9 `MemoryCascade.collectMemory` reads the
  most recent N journals into the system prompt alongside CLAUDE.md
- Settings: enable toggle, journal retention (default 30 days), max
  journal lines per CLAUDE.md cascade injection
- Writes: existing `append_to_note` / `create_note` per ADR-016 D2 +
  ADR-028 lesson 2 (compose existing primitives)
- **Open questions deferred to ADR-032:** what summary the agent
  writes (token budget vs. utility); whether to mark journal entries
  as "facts about operator" vs. "facts about session" (might want
  separate cascade slots); privacy controls (some users may NOT want
  the agent journaling about them — opt-in vs. opt-out default)

### D4. Phase 13 (Conversational notes) — recommended scope.

**Selected scope:**

- Path: `_chats/<YYYY-MM-DD>/<slug>.md` per chat turn or per
  conversation (D-question for ADR-033)
- Frontmatter: `chat_session: <id>`, `tokens_in/out`, `cost_usd`,
  `cited_chunks: [...]` mirroring drafting frontmatter
- Body: user message + assistant response, citations as `[[]]`
  wikilinks
- Settings: enable toggle, retention policy, slug strategy (per-turn
  vs. per-session), opt-out per turn (a "don't save this turn" toggle
  in ChatView)
- Searchability: the existing index picks these up automatically since
  they're regular notes
- **OQs:** turn-granularity vs. session-granularity (per-turn = more
  searchable; per-session = less clutter); how to handle long
  conversations (split? Single mega-note?); privacy default

### D5. Phase 14 (Daily briefing) — recommended scope.

**Selected scope:**

- Trigger: configurable time (default 7am operator local) OR on
  next-Obsidian-launch if missed
- Output: a note at `_briefings/<YYYY-MM-DD>.md` + a status bar pill
  + an OS notification on first launch of the day
- Content: digest pulling from curator (broken links, orphans, stale,
  missing frontmatter, drift candidates), memory (today's loaded
  cascade summary), activity (yesterday's writes + drafts), proactive
  draft suggestions (from v1.4.0 `DraftSuggestionRule`)
- Style: scannable; severity-sorted; click-to-act (each section links
  to the relevant view)
- **OQs:** scheduling reliability (Obsidian may not be running at
  7am); whether the briefing itself uses the agent (LLM-summarized
  digest vs. plain enumeration); cost concerns (one Opus call per
  morning is fine; one per launch is not)

### D6. Phase 15 (Negotiation mode) — recommended scope.

**Selected scope:**

- New chat mode: `'chat' | 'vault-qa' | 'negotiate'` (joins draft
  refine which is per-call not per-mode)
- System prompt addendum: explicit "your role is to find the
  strongest counter-evidence in this vault to the user's stated
  thesis. Cite the operator's own notes that contradict them."
- Retrieval pivot: query embedding is the user's thesis, but ranking
  prefers chunks with semantically OPPOSITE alignment (or just runs
  the regular query and then prompts the model to find the
  contradiction explicitly — D-question for ADR-035)
- UI: mode dropdown in ChatView gains the third option; banner when
  active
- **OQs:** the harder version (true semantic-opposite retrieval)
  needs new index machinery; the prompt-only version is far simpler
  and probably good enough for v1.8.0; can revisit in v1.8.x

### D7. Phase 16 (Time-travel queries) — recommended scope.

**Selected scope:**

- Architecture pivot: the SQLite engine gains an optional
  `at_commit: <sha>` filter; index entries gain a `commit_sha`
  column; the indexer subscribes to git events and stores chunks
  per-commit (or rebuilds on demand from worktree)
- New chat mode addendum (or option): "Query as of <date> /
  <commit>" — operator picks; agent retrieves from that snapshot
- Storage strategy: garbage-collect old commit indexes after N days
  (configurable); keep tags + key commits forever
- Writes: NOT supported in time-travel mode — operator can only READ
  past states
- **OQs (many; deepest phase):** index storage cost (per-commit chunks
  could 10x the DB); rebuild performance (do we cache? recompute on
  demand?); UX for picking a commit (calendar picker? Git log
  browser? Just type a SHA?); does this need a separate v2.x major
  bump or can it ride v1.X.x patches once shipped

### D8. Test coverage stays at the established bar.

**Selected:** every phase ships with a test suite that passes the
established pattern: pure modules first, integration tests for the
plugin wire-up, edge cases for failure modes. Project test count
should grow ~20-50 per phase. v2.0.0's larger surface area expects
a bigger jump (~100 tests).

### D9. Each phase preserves the architectural disciplines.

**Selected:** every phase adheres to:

- **ADR-016 D2** — every write through the diff card. No new write
  primitives unless they're truly new categories (Phase 12's
  `_memory/` writes use `append_to_note`; Phase 13's `_chats/` use
  `create_note`).
- **ADR-028 lesson 2** — compose existing primitives. New tools earn
  their existence by enabling something genuinely impossible
  otherwise.
- **ADR-030 lesson 2** — small DI interfaces become sharing seams.
  Phase 12's journal-writer should be small enough that Phase 13 can
  consume it.
- **ADR-024 lesson 1** — auto-anything earns trust slowly. Phase 14's
  daily briefing fires automatically; default should be OFF for
  first session, opt-in via "try it for a week" prompt.
- **ADR-024 lesson 2** — pure-rule first. Each phase's detection /
  generation logic gets a pure module before the plugin wiring.

### D10. Sequencing — one phase per session, MVP-then-follow-ups.

**Selected:** each phase gets a dedicated session (or two for v2.0.0).
The phase MVP ships first; named follow-ups land as v1.X.x patches per
ADR-030 lesson 1's "v1.X.x is the smallest credible deferral"
heuristic. No phase should block on the next.

If the operator wants to skip ahead (e.g., implement v1.7.0 daily
briefing before v1.6.0 conversational notes), that's allowed but
flagged: the dependency from 14 → 13 (briefing wants to summarize
yesterday's chats) means 14 will have less to summarize without 13.

## Risks / open questions

- **OQ1:** the 5 phases are all worth shipping individually, but the
  arc is most powerful when shipped together. If we get pulled to
  external priorities mid-arc, do we have a "pause checkpoint" that
  preserves momentum? Probably yes (each phase ships standalone), but
  worth confirming as we go.
- **OQ2:** privacy implications grow with each phase. Phase 12 (agent
  journals about you) and Phase 13 (chats become vault content) both
  raise consent questions. Default-off vs default-on shapes adoption.
  Settle in each phase's plan ADR.
- **OQ3:** v2.0.0 (time-travel) might warrant its own architectural
  ADR ahead of the plan ADR — index versioning is a load-bearing
  change that affects every consumer. Consider an "ADR-???: index
  versioning architecture" between this roadmap and ADR-036.

## Related

- [ADR-029](2026-05-14-adr-029-phase-9-memory-plan.md) — Phase 9 plan;
  the cascade architecture Phase 12 builds on top of.
- [ADR-030](2026-05-15-phase-9-close.md) — Phase 9 close; lesson 1
  ("v1.X.x version slots") is the heuristic this ADR's D1 commits to.
- [ADR-028](2026-05-14-phase-8-close.md) — Phase 8 close; lesson 2
  ("compose existing primitives") is the architectural discipline D9
  preserves across all 5 phases.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 ("every write
  through the diff card") — the constraint every new write surface
  inherits.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process; per-
  phase plan ADRs follow this template.
