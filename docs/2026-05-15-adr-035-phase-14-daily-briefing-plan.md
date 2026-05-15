---
title: "ADR-035: Phase 14 plan — Daily briefing (v1.7.0)"
type: decision
status: "Proposed (D1-D10 await batch acceptance)"
date: 2026-05-15
---

## Context

Phases 12 + 13 (planned in ADR-033 + ADR-034) make memory mutual
and conversations durable. Phase 14 turns the curator from
**reactive** ("operator runs `Sagittarius: Run curator` when they
remember") to **proactive** ("Sagittarius shows you what mattered
overnight when you open Obsidian in the morning"). It's the third
holy-shit move from ADR-031 — Sagittarius becomes a managing editor
of your vault, not just a tool you summon.

The substrate is mostly already there:
- **Curator findings** (Phase 7) — broken links, orphans, stale,
  schema, duplicates, tag-normalize
- **Memory cascade** (Phase 9 + 12) — what's loaded today, plus
  recent journals
- **Activity stream** (Phase 6) — what changed yesterday
- **Drafts panel** (Phase 8) — pending drafts + their citation
  drift status (Phase 9.x)
- **Draft suggestions** (Phase 9.x v1.4.0) — tag clusters lacking
  synthesis

Phase 14's job is to **aggregate** these into one scannable digest,
write it as a vault note, and surface it once per day (without
nagging).

This ADR follows the established plan-ADR template. 10 decisions,
batch-accept.

## Goals

- **One scannable digest per day** — operator sees it once, knows
  what changed + what's pending + what to do
- **Surfaces work, doesn't create work** — every item in the
  briefing has a click-through that takes the operator to the
  thing or proposes the action
- **Cheap by default** — composes existing primitives; one optional
  LLM call for the editorial summary
- **Opt-in + scheduling-tolerant** — fires when the operator first
  opens Obsidian on a given day, not at a server-side cron time
  (Obsidian might not be running)

## Decisions

### D1. Path: `_briefings/<YYYY-MM-DD>.md`, one per local day.

**Selected:** briefings live at `_briefings/2026-05-16.md`. Same
underscore-prefix-quarantine convention as `_drafts/`, `_memory/`,
`_chats/` — operator can browse them as regular notes; curator +
organization engine ignore the prefix.

One file per local day per the operator's `budgetResetTimezone`
setting (consistent with Phase 12 D1).

### D2. Trigger: first-launch-of-the-day, with manual override.

**Selected:** on plugin load, check if `_briefings/<today>.md`
exists. If not, AND today's date > the most-recent briefing's date,
generate one. **Single trigger per day**; subsequent restarts
re-render the same file (idempotent on existence check).

Operator-triggered command: `Sagittarius: Generate today's
briefing` overrides existence check (regenerates today's file from
current state). Useful when the operator opens Obsidian in the
morning, does an hour of work, and wants an updated briefing.

**Why not server-side cron:** Obsidian might not be running at
7am. First-launch-of-day means "you'll see it when you sit down" —
which is what the operator actually wants. ADR-024 lesson 1
(auto-anything earns trust slowly) plus a nod to "the operator is
the trigger, not the clock."

### D3. Sections — six fixed, severity-sorted within each.

**Selected:** every briefing renders six H2 sections in a fixed
order:

```markdown
# Briefing: 2026-05-16

## What changed yesterday
<from activity stream — writes, drafts created, drafts promoted,
 chat sessions, MCP write proposals approved>

## Curator suggestions ⚠ (3 high, 7 total)
<from curator orchestrator — broken links, orphans, stale notes,
 schema violations, duplicate candidates, tag drift; severity-sorted>

## Drafting backlog (2 pending, 1 with citation drift)
<from DraftsView — promoted? rejected? still pending? drift status>

## Synthesis opportunities (5 candidate tags)
<from DraftSuggestionRule — tags with N+ notes lacking a synthesis>

## Memory state
<cascade summary: which CLAUDE.md files would load right now,
 last 3 journal entries, total memory budget used>

## Open threads from journals
<extracted from "Open threads:" bullets across recent journal
 entries; a "what did past-me say to pick up?" surface>
```

Empty sections render with "(nothing to flag)" rather than
disappearing — operator learns the layout once.

### D4. Editorial summary — optional LLM call at the top.

**Selected:** above the six sections, optionally render a 2-3
sentence editorial summary the agent generates from the same
data. Toggleable per `briefingEditorialEnabled` (default ON if
`journalEnabled` is on, else OFF).

```markdown
> Yesterday you closed Phase 12, shipped v1.5.0, and approved 4
> MCP writes from Cursor. Today's most pressing item: the broken
> link in 30-Projects/q3.md (severity 0.85). 3 stale notes are
> over 60 days untouched in 50-FortressFlow.
```

The editorial is the difference between "data dump" and
"managing editor." LLM cost: one Sonnet call/morning ≈ <$0.01.
Bounded; cap on input tokens (5K) prevents runaway.

**Why optional:** an operator who doesn't want LLM cost on the
briefing path can flip it off; the six sections still render
deterministically without it. Composes existing primitives + one
new call (the agent gets the same data the sections show, returns
prose).

### D5. Reuses everything; one new pure module.

**Selected:**

- `src/briefing/BriefingComposer.ts` (new, pure) — takes the
  outputs of curator + activity + drafts + journal scans and
  produces the markdown sections. Stateless; testable; ~200 LOC.
- `src/briefing/BriefingScheduler.ts` (new, plugin-coupled) — owns
  the first-launch-of-day check; fires generation; persists
  `lastBriefingDay` in plugin data so re-launches don't double-fire.
- Plugin layer (main.ts) wires the existing `CuratorOrchestrator`,
  activity log reader, `DraftStore`, `DraftSuggestionRule`, and
  `LiveMemoryProvider.preview()` into the composer.

No new write tools (`create_note` for the briefing file goes
through the diff card per ADR-016 D2).

### D6. UX surfaces — Notice + status bar pill + chat link.

**Selected:** when a fresh briefing is generated:

1. **Notice** with a "View briefing" button (15s timeout, dismissible)
2. **Status bar pill** — "Briefing: 5 items" persistent until the
   operator opens the file (then dismisses for the day)
3. **ChatView footer link** on the next chat turn: "📋 Today's
   briefing has 5 items" → click opens the briefing

Three surfaces because operators have different attention modes:
some immediately follow the Notice; some click the pill later;
some discover the link mid-conversation.

### D7. Privacy default — opt-in (OFF until enabled), opt-out anytime.

**Selected:** `briefingEnabled: false` in `DEFAULT_SETTINGS`.
First-launch-of-day check no-ops when off. Operator must opt-in
explicitly. Echoes Phases 12 + 13 (and ADR-024 lesson 1).

Disabling later doesn't delete past briefings; operator manages
those files like any vault content.

### D8. Diff card on every briefing write — same as any other write.

**Selected:** the briefing's `create_note` proposal goes through
the existing diff card per ADR-016 D2. Once-per-day friction
profile (operator approves, file lands, day's done).

The Notice's "View briefing" button waits for the diff card to
clear before opening — sequencing avoids confusion ("did I
approve it yet?").

### D9. Zero new write tools — composes existing primitives.

**Selected:** `create_note` for the briefing file. If the briefing
already exists for today (operator regenerated via D2's command),
use `move_note` to rotate the old file to
`_briefings/_archive/<today>-N.md` first, then `create_note` for
the new one. Both already exist.

Same discipline as Phases 9, 12, 13. Five phases of "no new write
tools" in a row.

### D10. Ship plan — MVP at v1.7.0, named follow-ups as v1.7.x.

**Selected:**

**v1.7.0 MVP (target session: after Phase 12 + 13 lived in for ~1 week):**
- `BriefingComposer` (six sections; pure)
- `BriefingScheduler` (first-launch-of-day; persistent
  `lastBriefingDay`)
- `Sagittarius: Generate today's briefing` command
- Settings: `briefingEnabled` (default false),
  `briefingEditorialEnabled` (default tracks `journalEnabled`),
  `briefingTime` (placeholder for v1.7.1; default `'on-launch'`)
- Status bar pill + Notice + chat-footer link
- Diff card on save
- Tests: ~40 (pure composer + scheduler with injected clock)

**v1.7.x follow-ups (named slots per ADR-030 lesson 1):**
- **v1.7.1** — scheduled trigger options (`on-launch` | `at-7am` |
  `at-custom-time`) with reliable timer
- **v1.7.2** — briefing-as-chat: a "let's discuss this briefing"
  button that opens ChatView pre-loaded with the briefing as
  context
- **v1.7.3** — operator-pinned items: mark a curator suggestion as
  "show in tomorrow's briefing too" so important things don't
  scroll away
- **v1.7.4** — weekly + monthly digests (`_briefings/weekly/`,
  `_briefings/monthly/`) aggregating multi-day patterns

**Phase 14 close ADR** after operator has opened Obsidian for ~7
mornings with the briefing on. Lessons go in there.

## Risks / open questions

- **OQ1:** the editorial summary (D4) might drift toward managerial
  cliches ("Great progress yesterday!"). Sycophancy guard from
  ADR-033 D4 should be transferred to the briefing prompt
  verbatim.
- **OQ2:** "first-launch-of-day" misfires when the operator
  habitually leaves Obsidian running 24/7 — they won't see the
  briefing until they restart. v1.7.1's scheduled trigger fixes
  this; defer until we know if the issue is real.
- **OQ3:** big vaults with many curator findings will produce
  noisy briefings. v1.7.x might need a `briefingMaxItemsPerSection`
  cap (default 10?) so the briefing stays scannable.

## Related

- [ADR-031](2026-05-15-adr-031-roadmap-phases-12-16.md) — roadmap;
  Phase 14 scope provisionally outlined; this ADR is the binding
  plan.
- [ADR-033](2026-05-15-adr-033-phase-12-reverse-memory-plan.md) —
  Phase 12 plan; "open threads from journals" section (D3) reads
  the journal substrate Phase 12 establishes.
- [ADR-034](2026-05-15-adr-034-phase-13-conversational-notes-plan.md)
  — Phase 13 plan; the briefing's "what changed yesterday" section
  references chat-note saves from Phase 13.
- [ADR-022](2026-05-13-adr-022-phase-7-curator-plan.md) — Phase 7
  curator plan; the briefing's curator section is a render of the
  orchestrator's findings, no new detection logic.
- [ADR-019](2026-05-12-adr-019-phase-6-plan.md) — Phase 6 activity
  stream; the briefing reads the activity log for the "what changed
  yesterday" section.
- [ADR-024](2026-05-14-phase-7-close.md) — lesson 1 (auto-anything
  earns trust slowly) is why D7 ships opt-in default.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 (every write
  through the diff card) is the constraint D8 honors.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then same-session implementation.
