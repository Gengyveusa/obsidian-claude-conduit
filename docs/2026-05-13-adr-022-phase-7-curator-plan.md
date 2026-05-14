---
title: "ADR-022: Phase 7 plan — Curator (proactive vault maintenance beyond folder routing)"
type: decision
status: "Accepted (Thad signed off 2026-05-13: D1-D10 unchanged)"
date: 2026-05-13
---

## Context

Phase 5 (Organization Engine) answers *where* a note belongs — folder
routing and MOC membership. Phase 7 answers a wider question: *is your
vault healthy?* A vault that's been alive for a year accumulates
broken links, orphan notes, missing-frontmatter rows, duplicate drafts,
inconsistent tag spellings, and notes that haven't been touched in 90
days but still take up cognitive space.

A curator agent finds these and proposes fixes through the existing
Phase 5 suggestion queue + Phase 4 diff card. Same UX gates; new
detection logic feeding them.

**Why now:** Phase 5 + Phase 6 give us the substrate. The
SuggestionQueue accepts new `kind`s. The ActivityLog records every
classifier call so cost is observable. The diff card gates every write.
The infrastructure is paid for; Phase 7 is the application layer.

**Why not bigger:** It's tempting to wrap Phase 7 with Phase 8
(generative drafts) or Phase 9 (memory layer). Don't. Curator scope is
"propose a fix to something that exists"; Phase 8 is "draft something
new." Different judgment surfaces, different risk profiles.

**The hardest problem:** suggestion fatigue. A 5-year vault has
*hundreds* of latent issues. Surface them all at once and the user
disables the engine in a week. Phase 7 must rank, batch, and rate-limit.

---

## Decisions

### D1 — Scope of v1: which curator rules ship first

Eight categories of "vault hygiene" issue. Proposed v1 set:

| Category | Detection cost | Judgment cost | Value | v1 candidate? |
|---|---|---|---|---|
| **Broken wikilinks** — `[[X]]` where `X.md` doesn't exist | Cheap (string match) | Pure (no LLM) | High | ✅ ship |
| **Orphan notes** — no inbound links, not on a MOC | Cheap (graph walk) | Pure | High | ✅ ship |
| **Missing required frontmatter** — note in `22-Decisions/` without `status:` | Cheap (per-folder schema) | Pure | Medium | ✅ ship |
| **Stale notes** — last-modified > N days, never opened in N days | Cheap (vault.stat) | Pure | Medium | ✅ ship |
| **Duplicate-candidate pairs** — embedding cosine > 0.85 between two notes | Medium (existing retrieval) | LLM-judged | High but noisy | ⚠ v1.x |
| **Tag normalization** — `#project` vs `#projects` vs `#Project` | Medium (tag enumeration) | LLM-judged | Medium | ⚠ v1.x |
| **Merge candidates** — two notes that should become one | Same as duplicate | LLM-judged | High but very noisy | ❌ Phase 8 |
| **Split candidates** — one long note that should become several | Expensive | LLM-judged | Low frequency | ❌ Phase 8 |

**v1 (recommended):** ship the four pure-rule detectors first. No LLM
cost. Builds trust before we spend tokens.

**v1.x:** add the two LLM-judged detectors once UX is proven.

`<DECISION D1: ACCEPTED 2026-05-13 — v1 ships 4 pure-rule detectors; LLM-judged ones deferred to v1.x>`

---

### D2 — Trigger model

Phase 5's watcher fires per vault event. Phase 7's curator analyzes the
*corpus*; per-event is the wrong shape. Three options:

**(a) On-demand only — `Sagittarius: Run curator` command.** User
explicitly invokes; engine sweeps the vault; suggestions enqueue. Low
surprise, high control. Easy to start with.

**(b) Scheduled — daily / weekly sweep.** Set a cron-like interval
in settings; engine runs in the background. Higher surprise, no
opt-in friction.

**(c) Hybrid — on-demand by default; opt-in to scheduled.** Settings
gate the schedule (`curatorSweepIntervalDays`, default 0 = manual).
Same shape as Phase 5's `organizationSweepIntervalSec`.

`<DECISION D2: ACCEPTED 2026-05-13 — (c) hybrid; manual default>`

---

### D3 — Detection architecture: rules first, LLM second

Pure-rule detectors are deterministic functions over the vault: input =
file tree + metadata cache, output = `CuratorFinding[]`. No LLM. No
network. Cheap to run; cheap to test.

LLM-judged detectors take a shortlist (from a rule pre-filter) and
ask the classifier to confirm. Example: tag normalization rule
enumerates all tags, finds clusters with edit distance ≤ 2, hands the
cluster to Claude with "are these the same tag?" + retrieval-grounded
context.

**Architecture:** each detector is a `CuratorRule` class with:
- `name: string` — stable id
- `detect(corpus): Promise<CuratorFinding[]>` — produces candidates
- `confirm?(finding): Promise<boolean>` — optional LLM gate

Rule registry pluggable; new rules added without changing the curator
orchestrator. Same pattern as `ToolRegistry`.

`<DECISION D3: ACCEPTED 2026-05-13 — pure-rule first, optional LLM `confirm` second>`

---

### D4 — Suggestion kinds — extend Phase 5's union

Phase 5 has `RouteSuggestion` + `MocAddSuggestion`. Phase 7 adds:

| Kind | Action | Apply tool |
|---|---|---|
| `broken-link-fix` | Update link to suggested target, OR delete the broken link | `patch_note` |
| `archive-stale` | Move to `_archive/<year>/` | `move_note` |
| `add-frontmatter` | Insert missing fields from folder schema | `add_frontmatter` |
| `add-to-moc` | (v1.x) Orphan → suggested MOC | `link_notes` (same as Phase 5's moc-add) |
| `normalize-tag` | (v1.x) Rename tag across N notes | `patch_note` × N |
| `merge-duplicate` | (v1.x) Combine two notes | `patch_note` + `move_note` |

The SuggestionsView panel renders these alongside existing kinds; the
existing filter chip taxonomy extends. ActivityLog records each via
the existing `suggestion.enqueued` event (the kind field grows).

`<DECISION D4: ACCEPTED 2026-05-13 — five new suggestion kinds; reuse Phase 5 queue + Phase 4 apply path>`

---

### D5 — UX surface — extend SuggestionsView or new panel?

Two options:

**(a) Extend the existing Suggestions panel (recommended).** Add new
suggestion kinds; existing filter chips grow. One panel for all
proactive suggestions. Consistent with the user's mental model
(Phase 5 + Phase 7 are both "Sagittarius proposes a change").

**(b) New "Curator" panel.** Separate side panel for hygiene-class
suggestions. Cleaner mental separation; doubles the UI surface.

Sub-decision either way: add per-kind filter chips so the user can
narrow to "just broken links" or "just stale notes."

`<DECISION D5: ACCEPTED 2026-05-13 — (a) extend SuggestionsView with new kinds + new filter chips>`

---

### D6 — Cost controls

Pure-rule detectors are free. LLM-judged ones aren't. Two failure
modes to design against:

1. **Sweep cost explosion** — 5000-note vault × LLM call per pair =
   bankruptcy. Mitigated by: rule pre-filter shortlists; per-rule
   budget cap (`curatorRules.<name>.maxLlmCalls`, default 50/sweep);
   abort sweep on budget exceeded with a Notice.

2. **Suggestion fatigue** — 500 detected stale notes overwhelm the
   panel. Mitigated by: per-sweep enqueue cap (`curatorMaxPerSweep`,
   default 20); rank findings by severity score; oldest /
   most-broken first.

Per-rule severity scores: deterministic 0-1 number computed in
`detect()`. Higher = surface sooner.

`<DECISION D6: ACCEPTED 2026-05-13 — per-rule LLM budget cap (default 50), per-sweep enqueue cap (default 20), severity-ranked>`

---

### D7 — Trust calibration: feedback loop

Phase 5 has a known issue (ADR-018 lesson follow-up): no "stop showing
me these" learning from skips. Phase 7 should not ship the same gap.

**Proposal:** when the user Skips a suggestion of kind K with a
specific signature S (e.g. "always skip stale-archive for files in
`Inbox/`"), record the skip in a `curator-skip-patterns.json` learned
list. Future detect() calls consult the list and pre-filter matches.

This is a learned filter — *not* a learned classifier. Pure rule
augmentation. No LLM in the loop. Safe to ship.

`<DECISION D7: ACCEPTED 2026-05-13 — persist skip patterns; pre-filter future detections>`

---

### D8 — Rollout slicing

Four-version slice, longer than prior phases because curator is the
largest single-feature surface since Phase 4:

| Slice | Adds | Notes |
|---|---|---|
| **v1.0.0** — MVP | `CuratorRule` registry + 2 detectors (broken-links, orphans) + `Sagittarius: Run curator` command + 2 new suggestion kinds + tests | First detector pair; build trust |
| **v1.0.1** — Schema + stale | Add `missing-frontmatter` (per-folder schema config) + `stale-notes` detectors. Settings UI for stale threshold + folder schemas | Two more pure-rule detectors |
| **v1.0.2** — LLM-judged opt-in | Duplicate-candidate + tag-normalize detectors (off by default). Per-rule budget cap surfaced in settings | First LLM-judged work; high-friction defaults |
| **v1.0.3** — Phase 7 close | Skip-pattern learning + scheduled sweep + Phase 7 retrospective ADR + release | Closes the trust-calibration loop |

Calling this v1.0.0+ because shipping the curator is the
spec's first-line headline ("propose suggestions about your vault");
hitting v1.0.x is honest about that milestone.

`<DECISION D8: ACCEPTED 2026-05-13 — four-slice rollout v1.0.0 → v1.0.3>`

---

### D9 — Versioning leap: v0.x → v1.x

D8 proposes jumping from v0.8.2 directly to v1.0.0 (skipping a v0.9.x
phase if Phase 6.5 lands as v0.9.x per ADR-021). Two options:

**(a) Jump to v1.0.0 with Phase 7 (recommended).** The spec's headline
("propose suggestions about your vault") is satisfied by the curator.
v1.0.0 = "the thing the operator's been promising themselves." Honest
milestone marker.

**(b) Continue v0.10.x / v0.11.x cycle.** Defer v1.0.0 until later
phases. Safer if we discover phase-7-blocking issues mid-build, but
muddies the milestone.

If Phase 6.5 (ADR-021) lands first as v0.9.x, this decision still
holds: Phase 7 = v1.0.x regardless of intermediate phase numbering.

`<DECISION D9: ACCEPTED 2026-05-13 — (a) Phase 7 = v1.0.x>`

---

## Tool surface (binding for v1.0.0)

No new agent-facing tools. The curator uses the existing nine Phase 4
write tools (`move_note`, `patch_note`, `add_frontmatter`,
`link_notes`, etc.) for apply paths. The detection layer is *internal*
— it doesn't get registered with `ToolRegistry`; it's invoked by the
`Sagittarius: Run curator` command and by the scheduled sweep.

If a future ADR wants the agent to introspect curator findings ("Claude,
what does the curator think about this folder?"), that's a separate
threat-model decision.

`<DECISION D10: ACCEPTED 2026-05-13 — no new agent-facing tools in Phase 7>`

---

## Architecture sketch

```
src/
  curator/
    CuratorRule.ts                    # interface: name, detect, optional confirm
    CuratorOrchestrator.ts            # runs registered rules, applies budget + caps
    rules/
      BrokenLinkRule.ts               # v1.0.0
      OrphanRule.ts                   # v1.0.0
      MissingFrontmatterRule.ts       # v1.0.1
      StaleNoteRule.ts                # v1.0.1
      DuplicateCandidateRule.ts       # v1.0.2 (LLM-judged)
      TagNormalizeRule.ts             # v1.0.2 (LLM-judged)
    SkipPatternStore.ts               # v1.0.3
  organization/
    types.ts                          # extend Suggestion union with new kinds
  views/
    SuggestionsView.ts                # render new kinds; new filter chips
  main.ts                             # construct orchestrator + run-curator command + scheduled sweep
```

Lifecycle: orchestrator is constructed lazily on first command
invocation. Rules registered at construction. `runCurator()` iterates
rules, calls `detect()`, applies severity ranking, enqueues up to
`maxPerSweep` findings, logs each step to ActivityLog.

Settings: new "Curator (Phase 7)" section:
- `curatorEnabled` (default false)
- `curatorMaxPerSweep` (default 20)
- `curatorRules.<name>.enabled` (per-rule toggle)
- `curatorRules.<name>.severityFloor` (per-rule threshold)
- `curatorSweepIntervalDays` (default 0 = manual)
- `curatorStaleNoteThresholdDays` (default 90)
- `curatorFolderSchemas` (map of folder → required-fields list)

---

## Risks

| Risk | Mitigation |
|---|---|
| Suggestion fatigue tanks trust | `maxPerSweep` cap + severity ranking + per-rule enable/disable + D7 skip learning |
| Pure-rule detectors produce false positives (e.g. orphan rule misses MOCs in unusual places) | Each rule has a `severityFloor` setting; user can dial up the bar; rule docs include known false-positive patterns |
| LLM-judged detectors blow the budget | Per-rule `maxLlmCalls` cap + global daily budget guard (already exists from spec §3.4) |
| Curator wants to "fix" something the user intends to keep weird | Diff card still gates every write. User can Skip → skip pattern persists |
| Rule changes between versions invalidate the skip-pattern store | Skip patterns keyed by rule-name + signature; rule renames migrate via a `rules.aliases` map in the rule file |
| Performance on large vaults (10K+ notes) | All v1.0.x detectors are pure; budget for ≤2s sweep on 10K notes. Add profiling probe in v1.0.3 retrospective if needed |

---

## Out of scope (Phase 8+)

- Generative drafts (e.g. "write a summary of folder X") — Phase 8
- Merge / split candidates — Phase 8
- CLAUDE.md reader/writer / dossiers — Phase 9
- Cross-vault curation — Phase 10+
- Curator over MCP (external client invokes the curator) — depends on
  ADR-021 v0.9.x outcome; defer to Phase 7 retrospective

---

## Follow-ups (Phase 7 PRs)

- [ ] **PR 1 (v1.0.0 part 1):** `CuratorRule` interface + `CuratorOrchestrator` + tests.
- [ ] **PR 2 (v1.0.0 part 2):** `BrokenLinkRule` + `OrphanRule` + 2 new suggestion kinds + queue extension.
- [ ] **PR 3 (v1.0.0 part 3):** `Sagittarius: Run curator` command + SuggestionsView render + chips + settings.
- [ ] **PR 4 (v1.0.1):** `MissingFrontmatterRule` + `StaleNoteRule` + folder-schema config + stale threshold UI.
- [ ] **PR 5 (v1.0.2 part 1):** `DuplicateCandidateRule` (rule pre-filter + LLM confirm) + per-rule budget cap.
- [ ] **PR 6 (v1.0.2 part 2):** `TagNormalizeRule` (same shape).
- [ ] **PR 7 (v1.0.3):** `SkipPatternStore` + scheduled sweep + Phase 7 retrospective ADR + release.

---

## Related

- [ADR-017](2026-05-11-adr-017-phase-5-plan.md) — Phase 5 plan; Phase 7 reuses the SuggestionQueue + diff card pattern established here.
- [ADR-018](2026-05-12-phase-5-close.md) — Phase 5 retrospective; lesson 1 (normalizer between LLM and strict tool) applies to LLM-judged rules in v1.0.2.
- [ADR-019](2026-05-12-adr-019-phase-6-plan.md) — Phase 6 plan; ActivityLog (used here for curator probe instrumentation).
- [ADR-020](2026-05-13-phase-6-close.md) — Phase 6 retrospective; lesson 1 (emitter-seam sprawl) means we wire ActivityLog into the orchestrator via `this.plugin.activity` directly, not as a constructor dep on every rule.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan; D2 (every write through the diff card) constrains every Phase 7 apply path.
- [ADR-010](2026-05-04-sagittarius-build-process.md) — process; no code starts until this ADR is signed.
