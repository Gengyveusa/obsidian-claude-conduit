---
title: "ADR-024: Phase 7 close — Curator shipped as v1.0.3 (first v1.x release)"
type: decision
status: "Accepted"
date: 2026-05-14
---

## Context

Phase 7 (Curator) opened with ADR-022 on 2026-05-13 and closes today
with v1.0.3. The phase took seven PRs over one extended session
(#65 → #75 + this one), spanning four sub-versions:

- **v1.0.0** — three-PR slice:
  - PR 1 (#65): `CuratorRule` interface + `CuratorOrchestrator` —
    severity ranking, per-rule error isolation, `maxPerSweep` cap.
    Pure infrastructure; no rules registered yet.
  - PR 2 (#67): `BrokenLinkRule` + `OrphanRule` + `findingToSuggestion`
    converter. Two new suggestion kinds (`broken-link-fix`,
    `archive-stale`).
  - PR 3 (#69): `Sagittarius: Run curator` command + apply paths
    (patch_note for broken-link-fix, move_note for archive-stale)
    + curator settings section + VaultCorpus adapter.
- **v1.0.1** — one PR (#70): `MissingFrontmatterRule` (per-folder
  schema, no-LLM YAML key parsing) + `StaleNoteRule` (180-day default
  threshold, link-agnostic). Two new informational kinds
  (`add-frontmatter`, `stale-review`).
- **v1.0.2** — two-PR slice (the first LLM-judged work):
  - PR 1 (#73): `DuplicateCandidateRule` with injected
    `SimilarityFinder` + `LlmJudge`. Pure pre-filter (embedding
    cosine ≥ 0.85) + LLM confirm. Budget-capped at `maxLlmCalls`.
    New informational `duplicate-candidate` kind.
  - PR 2 (#75): `TagNormalizeRule` — text edit-distance pre-filter
    + LLM confirm. New informational `normalize-tag` kind.
- **v1.0.3** (this PR) — close: scheduled sweep
  (`curatorSweepIntervalDays`), ADR-024 retrospective, version bump.

Test count grew from 766 (Phase 6.5 close) to 800+, all green.
Substrate adds: `src/curator/` (10 files — types, rule interface,
orchestrator, VaultCorpus, findingToSuggestion, 6 rule modules).
Settings gained 5 fields. No new agent-facing tools (D10 invariant).

**First v1.x release.** ADR-022 D9 made this an explicit milestone:
the curator is the spec's headline ("propose suggestions about your
vault"); shipping it = the operator's-been-promising-themselves
moment.

## The two lessons of Phase 7

### 1. LLM-judged rules need the wiring + the judge bundled, not one then the other

PR #73 and #75 shipped `DuplicateCandidateRule` and `TagNormalizeRule`
as standalone modules with **injected** dependencies (`SimilarityFinder`,
`LlmJudge`). The rules are fully tested with fakes — both have 22+ unit
tests covering every code path. But the rules **aren't yet registered
in `runCurator`** because the production deps (a
`RetrievalSimilarityFinder` backed by `SqliteEngine`, an
`AnthropicLlmJudge` backed by `client.messages.create`) require
several hundred more lines of wiring + tests, and the v1.0.3 close
PR was the last chance to ship the version before the operator's
patience window closed.

The rules **work** — a user with TypeScript can construct them
manually. They aren't reachable via the user-facing command yet.

**Lesson:** LLM-judged rules are *user-facing* features even before
they're wired. Shipping the rule without the wiring means shipping
"trust us, this works in test" — which is true but unsatisfying.
Next time we plan a phase with LLM-judged components: bundle the
rule + the production judge in the same PR, or explicitly defer the
rule to the slice where the judge lands. Don't ship them apart.

(Follow-up: v1.0.x will land the wiring as a fast-follow patch.
The rule code is already there; the patch adds two adapters and a
settings toggle.)

### 2. Pure-rule first earned its keep — even more than expected

ADR-022 D1 staged four pure-rule detectors (broken-link, orphan,
missing-frontmatter, stale-note) before any LLM-judged ones. The
reasoning at planning time: build trust before spending tokens.

In practice the value was bigger:
  - Pure rules ran end-to-end across the whole pipeline (rule →
    orchestrator → finding → suggestion → queue → diff card → write)
    by PR 3 of v1.0.0. Every later PR could assume "the substrate
    works." When the LLM-judged rules landed in v1.0.2 they reused
    every layer without touching the substrate.
  - The 9 ranks of `Suggestion` union (Phase 5's 2 + Phase 7's 7)
    all coexist in `SuggestionsView`'s render branch. No special
    case for "this is a curator suggestion" because the queue +
    diff card already knew how to handle Suggestions of any kind.
  - The orchestrator's severity ranking + budget cap (designed for
    LLM-cost control in D6) also bounded suggestion fatigue for
    pure rules. The fatigue mitigation worked for free.

**Lesson:** when an ADR proposes "pure-rule first, LLM-judged
second" for a *cost* reason, expect the architectural benefit to
exceed the cost saving. The pure-rule path is the spine; LLM
judgment is decoration. Next phases that consider LLM-judged
detection (Phase 8 generative drafts? Phase 9 memory layer?)
should look for a pure-rule equivalent and ship that first even
if it's not the headline.

## Decision

Mark Phase 7 done. Update `CLAUDE.md` phase map. Sagittarius is at
v1.0.3 — the first v1.x release.

The curator works end-to-end for the four pure-rule detectors. The
two LLM-judged rules are tested in isolation but not yet registered
in `runCurator`; they land as a v1.0.x patch.

Carry the two lessons above as guardrails for Phase 8+:

1. LLM-judged rules ship with their production judge in the same
   slice. Don't separate.
2. Pure-rule equivalents come first even when the headline feature
   is LLM-driven. The pure substrate earns architectural debt back.

## Follow-ups (Phase 7 patches + Phase 8)

- **v1.0.x — wire LLM-judged rules into `runCurator`.** Build
  `RetrievalSimilarityFinder` (`SqliteEngine.allChunks()` → in-memory
  cosine pairs) + `AnthropicLlmJudge` (Messages API + structured
  prompt). Register both rules in `runCurator` when enabled in
  settings. Surface per-rule LLM-call counts in the activity stream.
- **v1.0.x — `SkipPatternStore` (ADR-022 D7).** Persist skip
  signatures `(kind, pathPrefix)`; pre-filter findings in the
  orchestrator. Closes the trust-calibration loop.
- **v1.0.x — apply paths for `normalize-tag` and
  `duplicate-candidate`.** Currently informational only. Tag
  normalize → batched `patch_note`. Duplicate → manual merge
  (Phase 8) or a "merge-into" `patch_note` + `delete` combo gated
  by the diff card.
- **Phase 6.5 MCP write-side.** ADR-023 deferred. Revisit when
  Phase 8 starts and the diff-card-focus problem has a sister
  solution.
- **Phase 8 — generative layer.** Spec §10. Cited drafts, proposal
  quarantine. Apply this ADR's lessons: bundle the LLM judge with
  every rule; look for pure-rule equivalents.

## Related

- [ADR-022](2026-05-13-adr-022-phase-7-curator-plan.md) — Phase 7
  plan; this ADR closes the loop on D8's four-version rollout.
- [ADR-021](2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md) /
  [ADR-023](2026-05-14-phase-6.5-close.md) — Phase 6.5 (MCP bridge);
  shipped in parallel with Phase 7 in the same session.
- [ADR-020](2026-05-13-phase-6-close.md) — Phase 6 retrospective;
  lesson 1 (emitter-seam sprawl) was honored — `runCurator` doesn't
  pass an `activityLog?` dep to every rule; it routes findings
  through the orchestrator and records once at the end.
- [ADR-018](2026-05-12-phase-5-close.md) — Phase 5 retrospective;
  lesson 1 (LLM → strict-tool normalizer) applies to the LLM-judged
  rules' confirm path. Phase 7 ships the rules but the apply
  normalizer (LLM's canonical-tag choice → `patch_note` args) lands
  with the v1.0.x wiring patch.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan; D2
  (every write through the diff card) honored by every Phase 7
  apply path.
- [ADR-010](2026-05-04-sagittarius-build-process.md) — process; this
  retrospective closes the Phase 7 PRs per §4. Curator ships as
  v1.0.x; ADR-022 D9 made this an explicit milestone.
