---
title: "ADR-018: Phase 5 close — organization engine shipped as v0.7.0"
type: decision
status: "Accepted"
date: 2026-05-12
---

## Context

Phase 5 (Organization Engine) opened with ADR-017 on 2026-05-11 and closed
today with v0.7.0. The phase took five PRs over two days (PRs #46 → #52) and
shipped against a 358-file vault that was already running the Phase 4 write
layer. What landed:

- **v0.6.0** (PR #46): MVP — `SuggestionsView` side panel, `OrganizationClassifier`
  (Sonnet 4.6 default per D4 override), `JsonSuggestionQueue` persisted to
  `.obsidian/plugins/obsidian-claude-conduit/suggestions.json`,
  `OrganizationWatcher` with 5-second debounce on vault `create`/`delete`
  events, `Sagittarius: organize inbox now` command, settings section.
- **v0.6.1** (PR #47): hotfix — classifier was occasionally emitting a
  proposed folder equal to the note's current folder. `move_note` rejects
  that as `fromPath and toPath are identical — nothing to do`, so the
  suggestion would appear, the diff card would never render, and Apply
  would silently fail. Fixed in the classifier (defensive normalizer).
- **v0.6.x slice** (PRs #48, #49, #50): `moc-add` classifier — shape-heuristic
  MOC detection, MOC discovery scanner, second-pass classifier that only
  runs when the route classifier says KEEP, panel renders moc-add cards,
  `applyMocAddSuggestion` routes through `link_notes` + diff card.
- **v0.7.0** (PRs #51, #52): Phase 5 close — periodic background sweep
  (`organizationSweepIntervalSec` setting), Apply-all / Skip-all bulk
  ops in the panel, status bar pill (`✦ N suggestions`), settings polish
  (numeric-field validation feedback).

Test count grew from 489 (start of phase) to 561, all green. The
constitution + concierge prompts are reused from Phase 3; no new
shared infrastructure beyond `SuggestionQueue` and `VaultEventEmitter`.

## The three lessons of Phase 5

### 1. LLM output → strict-input-tool needs a normalizer

The v0.6.0 → v0.6.1 hotfix was the cleanest failure mode of the phase.
The classifier prompt asked Claude to use a `KEEP` sentinel when it
didn't want to propose a move. Most of the time it did. Some of the
time it echoed back the current folder — semantically equivalent, but
not what the downstream `move_note` tool was willing to accept. The
move-tool path was correct (same-path is a no-op, the guard is
defensive). The classifier path was correct (its reasoning was sound,
"this note belongs where it is"). The seam between them broke.

**Lesson:** whenever an LLM-classifier's structured output feeds a tool
with strict input constraints, put a pure normalizer in between. Treat
the LLM contract as "best effort" and let the normalizer enforce
invariants the tool needs. Don't push that responsibility back into the
prompt — prompts drift, normalizers don't.

### 2. Cascading classifiers need explicit smoke-test setup

The first live smoke test of the v0.6.2 moc-add feature *didn't actually
exercise moc-add*. The test note was an ADR-shaped draft created in
`10-Inbox/`. The route classifier looked at it, said "this clearly
belongs in `22-Decisions/`" at 93% confidence, and short-circuited the
KEEP branch. `moc-add` never got a turn, because per ADR-017 D6 we wire
moc-add only after route says KEEP. Pass for end-to-end. No coverage
for the feature we were trying to test.

**Lesson:** when you ship a multi-stage classifier waterfall, the smoke
test plan needs to call out which stage each scenario targets *and* the
input shape that lands in that stage. Otherwise the easier classifier
will keep winning and the hard one stays unverified in production.

### 3. The console is doing your diagnostics job

Most of the time spent debugging Phase 5 smoke tests was in DevTools
running `await app.plugins.plugins['obsidian-claude-conduit'].suggestionQueue.list()`,
`.organizationWatcher.classifyNote(path)`, and friends. The watcher,
queue, and classifier were all reachable and the runtime behavior was
fine — the missing piece was a plug-in-facing way to see what they're
holding. Every diagnosis ran:

1. "Is the queue empty?" → console eval.
2. "Did the watcher fire?" → console eval.
3. "What did the classifier return?" → manual `classifyNote` call.

**Lesson:** when you ship infrastructure that holds state opaquely
(queue, debounce-timers, last-classifier-outcome), ship a Diagnostics
modal or command alongside it. The `Sagittarius: System check` from
Phase 3 (ADR-014 follow-up) was exactly this pattern for retrieval;
Phase 5 didn't get one and the smoke tests took 2-3× as long.

## Decision

Mark Phase 5 done. Update `CLAUDE.md` phase map. Phase 6 (Activity
Stream + MCP bridge) is next, but no work starts on it without its own
ADR per ADR-010.

Carry the three lessons above as guardrails for Phase 6+:

1. Every LLM → strict-tool seam needs a pure normalizer between them.
2. Multi-stage classifiers need scenario-targeted smoke tests, not
   "send a note and see what happens."
3. Infrastructure that holds opaque state ships with a diagnostics
   surface in the same release.

## Follow-ups (carry into Phase 6)

- **Diagnostics command** — `Sagittarius: organization diagnostics` that
  dumps queue contents, watcher state (enabled/folders/debounce
  timers), last classifier call (input path, model, outcome, latency,
  tokens). Should fit on one screen.
- **Apply outcome vocabulary** — `applyRouteSuggestion` /
  `applyMocAddSuggestion` currently return `'applied' | 'rejected' |
  'error'`. "Error" lumps tool-threw, conflict-detected, and
  user-closed-the-diff-card into one bucket. Split into at least
  `'conflict'` and `'error'` so the panel can surface the difference.
- **`frontmatter-suggest`** — ADR-017 D3 called this a v0.7.0 stretch.
  Stretch missed (intentionally — bulk ops + sweep were higher-leverage).
  Decision for Phase 6: either fold into the curator agent (Phase 7) or
  ship as a focused v0.7.x slice if Thad finds himself triaging tags
  manually.
- **Auto-merge** — Phase 5 PRs all paused at "green CI" because repo
  auto-merge was off. Now on (enabled mid-phase). Phase 6 PRs should
  flow with no manual click required.

## Related

- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan; the diff
  card contract that every Phase 5 Apply still honors.
- [ADR-017](2026-05-11-adr-017-phase-5-plan.md) — Phase 5 plan; this
  ADR closes the loop on D6's three-version rollout.
- [ADR-014](2026-05-09-phase-3-close.md) — template for this
  retrospective; the System check pattern is exactly what Phase 5
  needs for diagnostics (Lesson 3).
