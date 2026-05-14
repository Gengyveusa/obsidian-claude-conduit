---
title: "ADR-028: Phase 8 close — Generative layer shipped as v1.2.0 (drafting MVP + drafts panel)"
type: decision
status: "Accepted"
date: 2026-05-14
---

## Context

Phase 8 opened with ADR-026 on the morning of 2026-05-14 (D1-D10
batch-accepted) and closes the same day with v1.2.0. The phase
shipped in two deliberate slices across two PRs:

- **v1.1.1 (PR #86) — drafting MVP.** New `src/drafts/` package:
  `paths.ts` (slug + draft-path helpers per D1 (b) + D7 (a)),
  `citationContract.ts` (parse `[[]]` markers, reconcile against
  retrieved chunks, build YAML frontmatter, validate `strict`/
  `marked`/`free` policies per D2 + D3), `DraftingEngine.ts`
  (`AnthropicDraftingEngine.generate(spec)` with retry-on-policy-
  violation and `BudgetTracker` integration per D4). New
  `Sagittarius: New draft` command → `NewDraftModal` →
  retrieval-grounded engine → `create_note` via the existing
  diff card (D9 (a) — no new ProposalDiff variant). New
  `Sagittarius: Promote draft` command (checkCallback gated on
  the active file being under `_drafts/`) routes through
  `move_note` to strip the prefix. Three new settings:
  `draftingModel` (Opus 4.7 default), `citationPolicy` (`marked`
  default), `draftsDefaultDestination` (`10-Inbox` default).
  52 new tests.

- **v1.2.0 (this PR) — drafts panel + close.** New `DraftStore`
  enumerates `_drafts/`-prefixed files and parses each draft's
  YAML frontmatter into typed `DraftRecord`s (tolerates missing /
  malformed frontmatter; degrades to `null`). New `DraftsView`
  right-rail panel listing every draft with Open / Promote /
  Discard buttons; subscribes to vault `create`/`modify`/`delete`/
  `rename` so promotion + external edits reflect instantly. New
  always-visible status bar pill ("Sagittarius: N drafts") hides
  when the count is zero. New `Sagittarius: Open drafts panel`
  command. Promote + Discard route through existing `move_note` /
  `delete_note` (preserving ADR-016 D2). 10 new tests, ADR-028
  retrospective.

Test count grew from 931 (Phase 6.7 close) to 993. New files:
`src/drafts/{types,paths,citationContract,DraftingEngine,DraftStore}.ts`,
`src/views/{NewDraftModal,DraftsView}.ts`. **Zero new write tools,
zero new diff-card variants, zero new transaction shapes** — Phase
8's user-facing surface composes existing primitives per ADR-026
D9 (a).

## The two lessons of Phase 8

### 1. Two-slice cuts work when substrate is thin and the MVP is the natural boundary

ADR-027 lesson 1 said "three-slice cuts across architectural layers
beat splitting within a layer." Phase 8 confirmed and refined that
heuristic: when the substrate layer is *thin*, fold it into the MVP
slice. The substrate for Phase 8 was a folder-path convention + four
types + three settings keys — total under 200 LOC of plumbing. Phase
6.7's substrate was `Transaction.source` plumbed across 6 files plus
5 settings keys plus a settings-UI section — over 350 LOC of pure
plumbing. The Phase 6.7 substrate deserved its own version (v1.0.8)
because it was thick enough to read on its own; the Phase 8 substrate
would have shipped as invisible types-only plumbing, which is the
"ships nothing usable" anti-pattern.

The refined heuristic:
  - **Substrate that touches >5 files OR introduces a load-bearing
    type-system change (`Transaction.source`)** → its own version.
    The PR reads as "infrastructure landed; future work attaches
    here." Phase 6.7's v1.0.8.
  - **Substrate that's <200 LOC and entirely internal (path
    conventions, settings keys, helper functions)** → fold into
    the first behavior slice. The PR reads as "working feature
    landed; substrate is a sub-section of the diff." Phase 8's
    v1.1.1.

The visible-progress test: would a reader of the merged PR feel like
something happened? If yes, ship it. If no, fold it forward.

### 2. Reusing existing primitives beat building new ones — at the architectural cost it should

ADR-026 D9 (a) made the call early: drafts are `create_note`
proposals with `_drafts/` paths, not a new ProposalDiff variant.
Promotion is `move_note`, not a new `_drafts_lift` tool. The DraftsView
panel's Promote / Discard / Open buttons all route through existing
tools. The result: Phase 8 added zero new write tools, zero new
diff-card variants, zero new transaction shapes. The entire phase's
user-facing surface is a *composition* of primitives that already
existed.

This is the architectural payoff of ADR-016 D2 ("every write through
the diff card") — that constraint, originally about reviewability,
has become a *forcing function* for primitive reuse. Every Phase 8+
feature has to compose what's there, because adding a new write
primitive means adding a new diff-card variant (which the ADR-020
"emitter-seam sprawl" lesson warned against). The phases that paid
the up-front cost of building reusable primitives (Phase 4's write
tools, Phase 5's queue + diff card) earn the reuse dividend every
subsequent phase.

**Lesson:** when planning a phase, the first question to ask is "what
existing primitives compose into this?" The honest answer might be
"nothing — we need new primitives." Often it's "all of them, but the
glue is non-trivial." Phase 8 was the latter. ADR-024 lesson 2 ("pure-
rule first earned its keep") and ADR-027 lesson 2 ("realistic case
first") are the same heuristic applied to other domains: shipping with
existing primitives is a deliberate architectural discipline.

(Echo of ADR-027 lesson 1: when the cut lands on architectural-layer
boundaries, the substrate / behavior / UX shape stays cleanly
testable. Phase 8's MVP (v1.1.1) is the behavior; v1.2.0 is the UX.
Substrate folded into MVP per Lesson 1 above.)

## Decision

Mark Phase 8 done. Update `CLAUDE.md` phase map. Sagittarius is at
v1.2.0 — the minor bump signals "Sagittarius now writes proactively-
on-request, with cited drafts in quarantine."

The generative layer ships:
- User-initiated drafting via `Sagittarius: New draft`
- Inline `[[note-path]]` citations + `cited_chunks: [...]`
  frontmatter for full provenance
- `marked` citation policy by default (uncited synthesis allowed,
  wrapped in `<!-- uncited -->` HTML comments)
- Retry-on-policy-violation with `strictFallback` warning
- `_drafts/<destination>/<slug>.md` quarantine; promotion via
  `move_note` to strip the prefix
- Drafts side panel + status bar pill + Open/Promote/Discard
  buttons
- Three new settings: `draftingModel`, `citationPolicy`,
  `draftsDefaultDestination`

Carry the two lessons above as guardrails for Phase 9+:

1. When planning slices, count the substrate's footprint first.
   Thin (<200 LOC, internal only) → fold into MVP. Thick (load-
   bearing types or >5-file plumbing) → its own version.
2. "What existing primitives compose into this?" is the first
   question every phase plan should answer. The ADR-016 D2
   constraint forces primitive reuse and pays off compounding
   dividends.

## Follow-ups (Phase 8 patches + Phase 9)

- **v1.2.x — ChatView Draft mode (ADR-026 D5 (d) + D6 (c)).** When
  a draft is open in the workspace, the chat panel switches into
  "refining draft X" mode. Tool calls scope to that path; whole-
  draft rewrites use `patch_note` with a single op spanning the
  entire body. Currently the user iterates via direct file editing
  in Obsidian's markdown editor, which is functional but spartan.
- **v1.2.x — OQ1 citation-drift verification.** Currently the
  promote path doesn't re-verify that every `cited_chunks: [...]`
  entry still resolves to a current chunk in the index. A pre-
  promotion pass could warn the operator when citations have gone
  stale.
- **v1.2.x — `DraftSkipPatternStore`.** Mirroring ADR-022 D7's
  curator skip patterns: when a user repeatedly discards drafts of
  shape X, remember the pattern and warn before drafting again.
- **v1.3.0 — proactive draft suggestions (ADR-026 D8 (b)).**
  Curator orchestrator gets a `DraftSuggestionRule` that detects
  "you have N notes about X but no synthesis" and proposes a draft
  via the existing suggestion queue. ADR-022 lesson 2 applies:
  build the pure-rule equivalent first.
- **Phase 9 — memory layer.** Spec §11. CLAUDE.md reader/writer,
  dossiers. Apply this ADR's lessons: count substrate; reuse
  primitives. The memory layer probably has a load-bearing
  substrate (a `Dossier` type) — that'll deserve its own version.

## Related

- [ADR-026](2026-05-14-adr-026-phase-8-generative-layer-plan.md) —
  Phase 8 plan; this ADR closes the loop on D1-D10. OQ1-OQ3 remain
  open (none surfaced during implementation in a way that demanded
  resolution); deferred to v1.2.x patches.
- [ADR-027](2026-05-14-phase-6.7-close.md) — Phase 6.7 close;
  lesson 1 (three-slice cuts) refined by this ADR's lesson 1
  ("count the substrate's footprint").
- [ADR-024](2026-05-14-phase-7-close.md) — Phase 7 close; lesson 2
  (pure-rule first) is the same heuristic as this ADR's lesson 2
  (reuse existing primitives), applied to curator vs. drafting.
- [ADR-020](2026-05-13-phase-6-close.md) — Phase 6 close; lesson 1
  (emitter-seam sprawl) is the architectural reason D9 (a) was the
  right call. New ProposalDiff variants are expensive; existing
  ones compose for free.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan;
  D2 ("every write through the diff card") is the constraint that
  made Phase 8's primitive-reuse possible. Every new feature
  composes existing tools because adding new ones requires
  paying the diff-card-variant tax.
- [ADR-010](2026-05-04-sagittarius-build-process.md) — process;
  this retrospective closes the Phase 8 PRs per §4. v1.2.0 is a
  minor bump signaling the new generative capability per ADR-026
  D10 (b).
