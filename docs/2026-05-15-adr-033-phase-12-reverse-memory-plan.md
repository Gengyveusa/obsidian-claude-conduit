---
title: "ADR-033: Phase 12 plan — Reverse-memory journal (v1.5.0)"
type: decision
status: "Accepted (D1-D10 batch-accepted 2026-05-15)"
date: 2026-05-15
---

## Context

Phase 9 made memory one-directional: operator writes CLAUDE.md →
agent reads it. Phase 12 inverts that arrow: **agent writes durable
journals → cascade reads them on the next session.** Within a few
sessions the agent has a memory of *you* — your patterns, your
recent decisions, the threads you're holding open.

Per ADR-031's roadmap, this is the smallest of the 5 holy-shit
moves: built directly on top of Phase 9's `MemoryCascade` +
`LiveMemoryProvider`, no new write tools needed (composes existing
`append_to_note` per ADR-016 D2 + ADR-028 lesson 2). v1.5.0 MVP +
v1.5.x follow-ups; close ADR after operator has lived with the
journal for a beat.

This ADR follows the established plan-ADR template (ADR-026, 029,
032): 10 decisions, batch-accept, same-session implementation.

## Goals

- **Agent's perspective lands in the vault**, durable + searchable
- **Cascade picks it up automatically** on the next session
- **Operator stays in control** — diff card on every journal write;
  opt-in by default (ADR-024 lesson 1)
- **Cheap to run** — bounded token cost; no per-turn overhead
- **No new write tools** (compose existing primitives)

## Decisions

### D1. Path: `_memory/<YYYY-MM-DD>.md`, one file per local day.

**Selected:** journals live at `_memory/2026-05-15.md`. Underscore
prefix marks the folder as Sagittarius-managed (same convention as
`_drafts/`). One file per local day per the operator's configured
timezone (defaults match `budgetResetTimezone`). Multiple session
journals on the same day append to the same file as separate H2
sections.

**Why daily files, not session files:** files-per-session would
explode quickly (a power user with 5 sessions/day = 1,800 files/year);
files-per-day is bounded (~365/year) and matches how operators think
about their work. Within a day, sessions append.

**Cascade behavior** (D5 below) reads the most-recent N daily files.

### D2. Operator-triggered MVP, auto-trigger follows in v1.5.x.

**Selected:** v1.5.0 MVP exposes one command:

```
Sagittarius: Journal this session
```

The operator runs it when they're done thinking. The agent reads
the conversation log since the last journal entry, summarizes per
D3, and proposes an `append_to_note('_memory/<today>.md', entry)`
through the existing diff card.

**Why not auto-trigger:** "what counts as a session ending" is
genuinely ambiguous (plugin unload? 30-min idle? specific
conversational signal?). Each option has failure modes (`onunload`
might cut off async writes; idle-timer fires while you're thinking;
conversational detection requires another LLM call). Ship the
operator-triggered command first; learn from real use what auto-
trigger should look like.

**Follow-up slot:** v1.5.1 — `journalAutoTrigger` setting with
options `manual` (default) | `on-unload` | `idle-30m`.

### D3. Journal entry format — structured + bounded.

**Selected:** each entry is a markdown H2 section (timestamp +
short title) with a four-bullet body:

```markdown
## 2026-05-15 22:14 — Phase 12 planning

- **Worked on:** drafted ADR-033 (reverse-memory journal plan); 10 decisions; batch-accept pattern
- **Decided:** ship MVP as operator-triggered; auto-trigger deferred to v1.5.1
- **Learned about operator:** prefers tight planning ADRs before code; power-hour energy after midnight; references Kansas lyrics
- **Open threads:** v1.4.2 tag/release; Phase 13 conversational notes
```

Four bullets, each capped at ~80 chars. Total entry stays under
~400 tokens. Bounded means cascade injection stays cheap (D5).

**Why structured rather than free-form:** structure makes the
entries scannable (operator can grep "Learned about operator:"
across journals) and predictable (next session's cascade reads
known fields rather than parsing prose). Structure is also a
forcing function on quality — four bullets means each bullet has
to earn its place.

### D4. Agent generates via LLM call — same Conduit, separate prompt.

**Selected:** journal generation uses `ConduitAgent` with a custom
`mode: 'journal'` (joining `chat` / `vault-qa` / `draft-refine`).
The system prompt for journal mode is tight:

```
You are summarizing the operator's last working session for a
durable memory journal. Output ONLY the journal entry as a markdown
H2 section with EXACTLY the four bullets specified in the format
template. No preamble, no commentary, no other content. The entry
will be appended to the operator's vault verbatim.
```

User message gives the conversation transcript + the format
template. Agent returns the H2 block.

**Why a new mode** rather than a prompt-only switch: keeps the
journal generation path testable + auditable (it shows up in the
activity log distinctly); makes future enhancements (e.g.,
auto-classify entries by topic) plumb cleanly.

### D5. Cascade integration — separate section, separate cache breakpoint.

**Selected:** `MemoryCascade` gains a new `collectJournal(opts)`
that reads the most-recent N journal files. Provider produces a
labeled section that sits ABOVE the CLAUDE.md cascade in the
system prompt:

```
# Memory: recent session journals (most recent first)

## 2026-05-15
... entry ...

## 2026-05-14
... entry ...

# Memory: CLAUDE.md
... existing cascade ...
```

Own `cache_control: ephemeral` breakpoint so journal additions
(new entry) don't invalidate the CLAUDE.md cache.

**Default N = 3 days.** Configurable via `journalCascadeDays`
setting. 3 days × 1-2 entries/day × 400 tokens ≈ 2400 tokens —
manageable in the 50KB budget D4 (Phase 9) already allows.

Total memory budget stays at 50KB; journals + CLAUDE.md share it.
Soft-truncation per Phase 9 D4 still applies.

### D6. Retention — operator manages files; no auto-delete.

**Selected:** v1.5.0 ships **no retention policy**. Journals
accumulate indefinitely under `_memory/`. Operator can:

- Delete files manually if they want
- Move them to `_memory/_archive/` (cascade excludes `_archive/`)
- Run the curator over `_memory/` like any other folder

**Why not auto-delete:** retention policy is a meaningful decision
("how long does the agent's memory of me live?") and shouldn't be
hardcoded. v1.5.x can add a configurable `journalRetentionDays`
setting once we see actual use.

### D7. Privacy default — opt-in (OFF until operator enables).

**Selected:** `journalEnabled: false` in `DEFAULT_SETTINGS`. The
command exists but emits a Notice prompting the operator to enable
in settings on first invocation.

**Why opt-in:** ADR-024 lesson 1 ("auto-anything earns trust
slowly"). Journaling about the operator is a meaningful trust
ask — opt-in lets the operator try it deliberately. Echoes
ADR-031 D9 (which earmarks privacy controls as a Phase 12
decision).

Settings UI surfaces a clear explanation of what gets written,
where, and how to delete. Operator must opt-in to start; opt-out
deletes nothing (existing journal files stay; operator can rm).

### D8. Diff card on every journal write — same as any other write.

**Selected:** journal writes route through `append_to_note` →
existing diff card per ADR-016 D2. Operator sees the proposed
entry inline, hits Accept or Reject.

**Why not auto-approve:** consistency. Every write through the
diff card is the constraint that makes Sagittarius trustable
across all phases (Phase 6.7 lesson 1, Phase 8, Phase 9). Breaking
it for journals would create a precedent ("but THIS write doesn't
need approval...") that erodes the invariant fast.

**Friction concern:** "approve a modal once per session" is
acceptable — the operator triggered the command; the diff card is
a final review, not a surprise interrupt. If real use proves it
annoying, v1.5.x can add an "auto-accept journal writes from this
session" opt-in toggle inside the diff card itself (echoing the
"approve all" curator pattern).

### D9. No new write tools — composes existing primitives.

**Selected:** journal generation outputs text; `append_to_note`
writes it; cascade reads it. Zero new tools. Same discipline as
Phase 9 D8 (memory edits use existing tools).

**What if today's journal file doesn't exist?** First entry of
the day proposes a `create_note` instead; subsequent entries
propose `append_to_note`. Both already exist. Logic lives in the
plugin layer (`runJournalSession`), not in the agent.

### D10. Ship plan — MVP at v1.5.0, named follow-ups as v1.5.x.

**Selected:**

**v1.5.0 MVP (this session if time allows; else next):**
- `Sagittarius: Journal this session` command
- `JournalGenerator` that drives `ConduitAgent` in journal mode
- `MemoryCascade.collectJournal` + provider integration
- Settings: `journalEnabled` (default false), `journalCascadeDays`
  (default 3)
- Tests: ~30 across generator, cascade, command

**v1.5.x follow-ups (named slots per ADR-030 lesson 1):**
- **v1.5.1** — auto-trigger options (`manual` | `on-unload` | `idle-30m`)
- **v1.5.2** — retention policy (`journalRetentionDays` setting)
- **v1.5.3** — "Journal these chat turns" command (per-conversation
  delta journal, not whole session)
- **v1.5.4** — operator can view journals via a "Memory journals"
  side panel (read-only browser)

**Phase 12 close ADR** after operator has lived with the journal
for ~1 week. Lessons go in there.

## Risks / open questions

- **OQ1:** the journal format (D3 four bullets) is a guess. Real
  use might reveal that 3 bullets / 5 bullets / different categories
  work better. Settle in v1.5.x.
- **OQ2:** how the agent writes about the operator can drift
  toward sycophancy ("operator was insightful today"). The system
  prompt (D4) should guard against this — explicit instruction to
  state facts, not flatter. Verify in real use.
- **OQ3:** combined cascade size (journals + CLAUDE.md) might bust
  the 50KB budget more often than Phase 9 alone did. If so, raise
  default or add separate budget for journals.

## Related

- [ADR-031](2026-05-15-adr-031-roadmap-phases-12-16.md) — roadmap;
  Phase 12 scope provisionally outlined; this ADR is the binding
  plan.
- [ADR-029](2026-05-14-adr-029-phase-9-memory-plan.md) — Phase 9
  plan; `MemoryCascade` + `LiveMemoryProvider` substrate Phase 12
  builds on.
- [ADR-030](2026-05-15-phase-9-close.md) — Phase 9 close; lesson 1
  (v1.X.x version slots) is the ship-plan discipline D10 commits
  to.
- [ADR-024](2026-05-14-phase-7-close.md) — Phase 7 close; lesson 1
  (auto-anything earns trust slowly) is why D7 ships opt-in.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 (every write
  through the diff card) is the constraint D8 honors.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then same-session implementation.
