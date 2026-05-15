---
title: "ADR-030: Phase 9 close — Memory layer shipped (v1.3.0 MVP → v1.3.4 follow-ups)"
type: decision
status: "Accepted"
date: 2026-05-15
---

## Context

Phase 9 opened the morning of 2026-05-14 with ADR-029 (D1-D10 batch-
accepted) and closes 16 hours later with v1.3.4. The phase shipped
in five tagged versions across two sessions — MVP first, then three
follow-ups that made the cascade actually useful in practice:

- **v1.3.0 — MVP (ADR-029).** `MemoryCascade.ts` (pure: collect +
  format + footer; root + every ancestor folder of the active file;
  50KB soft-truncate). `LiveMemoryProvider.ts` (per-turn workspace
  read; `preview()` for UI). `ConduitAgent` gains optional
  `memoryProvider` dep; `buildSystemPrompt` inserts the memory block
  between constitution and hangarVoice with its own
  `cache_control: ephemeral` breakpoint per D5. Status bar pill +
  preview modal + chat-response footer + 2 settings. **Zero new
  write tools** per D8.

- **v1.3.1 — Phase 10 polish slice 1.** README full rewrite (was
  stale at v0.2.5; now covers all 8 phases). styles.css gaps
  filled (drafts panel, memory footer, status bar pill classes).
  manifest.json `fundingUrl`. `CHANGELOG.md` +
  `docs/RELEASE_CHECKLIST.md` + `docs/COMMUNITY_PLUGIN_SUBMISSION.md`
  staged for Phase 11. Pre-emptive `fetch → requestUrl` swap on
  the localhost MCP health-check probe to silence one
  predictable community-plugin-reviewer flag.

- **v1.3.2 — ChatView Draft mode (ADR-026 D5(d)+D6(c) follow-up).**
  When the active file is under `_drafts/`, ChatView shows a
  "Refining draft: …" banner; `chat()` is called with `draftPath`;
  the agent's system prompt gains a "Mode: DRAFT REFINE" block
  with explicit `patch_note(path='<draft>', ...)` instructions.
  Banner refreshes on `active-leaf-change`. Zero new tools.

- **v1.3.3 — Drafting engine reads memory (v1.3.x follow-up).**
  `AnthropicDraftingEngine` gains optional `memoryProvider` dep
  (same `MemoryProvider` interface ConduitAgent uses); when set,
  the cascade text appears as a `# Operator memory` block between
  persona and output-format in the drafting system prompt. House
  style + project conventions in `CLAUDE.md` now reach generative
  output, not just chat. Both first attempt and retry-on-policy-
  violation pass the same memory string.

- **v1.3.4 — Citation drift verification at promotion (ADR-026 OQ1
  follow-up bundled into Phase 9).** New `src/drafts/citationDrift.ts`
  (pure — `verifyCitations`, `formatDriftSummary`); before
  `Sagittarius: Promote draft` fires `move_note`, every
  `cited_chunks` entry is checked against the current retrieval
  index. Two drift classes (missing chunks = note rechunked;
  missing notes = source deleted/moved). Confirmation modal lists
  drifted entries; "Promote anyway" / "Cancel" — citations are
  documentation, not contracts. Drift-check failure logs a warn
  and proceeds (never blocks promotion).

Test count grew from 993 (Phase 8 close) to 1050 (+57). New files:
`src/memory/{MemoryCascade,LiveMemoryProvider}.ts`,
`src/drafts/citationDrift.ts`. `ChatView` and `DraftingEngine`
gained memory wiring without new write tools or new diff-card
variants — the architectural discipline ADR-016 D2 created and
ADR-028 lesson 2 codified continues to compound.

## The two lessons of Phase 9

### 1. Deferrals at phase close are not "later" — they're committed v1.X.x scope

ADR-029 D10 named three OQs and explicitly deferred them to v1.3.x
patches. ADR-026 had similarly deferred ChatView Draft mode (D5(d))
and citation drift (OQ1). All five of those follow-ups shipped within
24 hours of the MVPs that named them — across two sessions. The
phase map became a forward-looking commitment, not a rear-mirror
summary.

The pattern that worked:

  - **At MVP close, name every deferral with an explicit version
    slot** ("ChatView Draft mode → v1.3.x"). The slot is a
    promise of when, not just a TODO.
  - **At phase close, audit which slots got filled.** v1.3.0
    named 3 follow-ups; v1.3.2-1.3.4 filled all 3. Phase 9's
    close (this doc) reports a 100% follow-up close rate.
  - **A deferred item that doesn't get a version slot will
    rot.** Things deferred to "future" or "Phase X+1" land
    less reliably than things deferred to "v1.3.x patch."

The "v1.X.x" version-slot syntax matters: it's the smallest
commitment that's still concrete enough to fall off a checklist.
Bigger ("v2.0", "Phase 10") is too far; smaller ("next session")
is too vague. v1.X.x = "soon, in the same minor cadence we're
already in."

This refines ADR-024 lesson 1 ("auto-anything earns trust slowly")
applied to phase scope: deferred items earn trust by *shipping
within the slot they were promised*. The first time a v1.X.x
deferral slips to v1.X+1.x, the next phase plan should question
whether deferrals are real commitments or fig leaves.

### 2. Small dependency-injection interfaces become natural sharing seams

`MemoryProvider` was designed for `ConduitAgent` in v1.3.0:

```ts
export interface MemoryProvider {
  collect(): Promise<string | null>;
}
```

That's the entire interface. No consumer-specific knobs, no
`forChat()` / `forDrafting()` discriminator, no options bag.
Three patches later (v1.3.3), `AnthropicDraftingEngine` reused
the same interface — same `LiveMemoryProvider` instance, same
contract — with zero provider changes. The drafting engine was
never on the v1.3.0 design board; the interface was just small
enough to absorb a new consumer.

The recurring pattern across the codebase:

  - `ApprovalGate` (Phase 4) — `request(proposal): Promise<Decision>`.
    Consumed by ChatView, ExternalProposalsView, and the McpHandler
    queue, with no consumer-specific surface.
  - `BudgetTracker` (Phase 3) — `assertAvailable(n)` + `commit(usage)`.
    Consumed by ConduitAgent, AnthropicDraftingEngine, and the
    embedding indexer.
  - `RetrievalLayer` (Phase 3) — `queryUnified(opts)`. Consumed by
    ConduitAgent (chat retrieval) AND the drafting engine (chunk
    grounding) AND citation drift verification (chunk lookup).
  - `MemoryProvider` (Phase 9) — `collect()`. Consumed by
    ConduitAgent and AnthropicDraftingEngine.

The constraint that produces these seams: **DI interfaces should
contain "what to do," not "for whom."** If the second consumer
needs new fields, the interface is leaking consumer knowledge and
will accrete options over time. If the second consumer drops in
clean, the interface is the right size.

The trade-off is up-front cost: separating provider from consumer
in the first place takes design effort even when there's only one
consumer. The payoff arrives the second time, the third time, etc.
Phase 4's `ApprovalGate` paid this cost; every later phase that
introduced a new write surface (Phase 6.7's external queue, Phase
8's drafting, Phase 9's memory writes) reused the gate without
touching it.

**Lesson:** when introducing a new dep on an existing system,
favor a small interface that names what's being provided over a
bigger one that names what it's for. `MemoryProvider` not
`ChatMemorySource`. `ApprovalGate` not `ChatViewProposalGate`.
The naming is a forcing function on the interface size.

## Decision

Mark Phase 9 done at v1.3.4. Update `CLAUDE.md` phase map. Carry
the two lessons above as guardrails for Phase 10+:

1. **Phase plans must list deferrals with explicit v1.X.x version
   slots.** "Future" and "Phase X+1" are non-commitments; v1.X.x
   is the smallest unit of credible deferral. Phase close ADRs
   audit follow-up shipping rates.
2. **DI interfaces name what's provided, not who consumes.** The
   first consumer pays the cost of the seam; the second consumer
   collects the dividend. Naming is the forcing function.

The Sagittarius capability surface is now feature-complete for the
roadmap up to Phase 11:

- Read layer (chat + retrieval + 5 read tools)
- Write layer (9 write tools, all diff-card-gated)
- Organization engine (auto-routing + MOC maintenance)
- Activity stream (events + diagnostics + digest)
- MCP bridge (read tools always; write tools + delete behind
  toggles; queue + side panel + OS notifications for external
  proposals)
- Curator (proactive vault hygiene)
- Generative drafting (cited drafts, quarantine, drafts panel,
  ChatView Draft mode, citation drift verification)
- Memory layer (CLAUDE.md cascade, status bar, footer, drafting +
  chat consumers)

Remaining roadmap: **Phase 10 polish** (screenshots, command
palette grooming, hotkey defaults — README + styles already done
at v1.3.1) + **Phase 11 release** (signed tag, GitHub release,
community-plugin-registry submission — checklists already in
`docs/`).

## Follow-ups

- **v1.4.0 — proactive draft suggestions (ADR-026 D8(b)).**
  Curator orchestrator gets a `DraftSuggestionRule` that detects
  "you have N notes about X but no synthesis" and proposes a
  draft via the existing suggestion queue. Apply ADR-024 lesson
  2 ("pure-rule first") — build the detection logic as a pure
  function before wiring it to the orchestrator.
- **v1.X — drift report for the activity stream.** Currently
  drift only surfaces at promotion. A periodic "audit all
  drafts" command could populate the activity stream with stale
  citations, making the curator aware.
- **Phase 10 — screenshots + command palette grooming.**
  Screenshots need an actual Obsidian instance (operator's job).
  Command-palette grooming is procedural — review every
  `addCommand` for consistency.
- **Phase 11 — public release.** RELEASE_CHECKLIST.md staged at
  v1.3.1; just run it for the next tagged version.

## Related

- [ADR-029](2026-05-14-adr-029-phase-9-memory-plan.md) — Phase 9
  plan; D1-D10 batch-accepted. This ADR closes the loop on all 10
  decisions. OQ1 (cache interference), OQ2 (budget calibration),
  OQ3 (active-file anchor edge cases) remain open — defer to
  v1.3.x or v1.4.x as real-use telemetry surfaces.
- [ADR-028](2026-05-14-phase-8-close.md) — Phase 8 close; lesson 2
  ("reuse existing primitives") is the architectural ancestor of
  this ADR's lesson 2 ("small interfaces become sharing seams").
  Same discipline at a different scale.
- [ADR-027](2026-05-14-phase-6.7-close.md) — Phase 6.7 close;
  lesson 1 (three-slice cuts) refined here as "v1.X.x version
  slots are the smallest credible deferral."
- [ADR-026](2026-05-14-adr-026-phase-8-generative-layer-plan.md) —
  Phase 8 plan; D5(d) (ChatView Draft mode) and OQ1 (citation
  drift) were the deferrals that became v1.3.2 and v1.3.4
  respectively. Concrete data point for lesson 1 above.
- [ADR-024](2026-05-14-phase-7-close.md) — Phase 7 close; lesson 1
  ("auto-anything earns trust slowly") is the parent heuristic
  this ADR's lesson 1 specializes for phase scope.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan; D2
  ("every write through the diff card") is the constraint that
  made memory writes (v1.3.0 D8) compose existing primitives
  rather than spawn new write tools. Same dividend, fifth phase
  in a row.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  this retrospective closes Phase 9.
- Spec §11 — "Memory layer" requirement Phase 9 satisfies.
