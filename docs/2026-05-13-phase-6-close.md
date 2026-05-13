---
title: "ADR-020: Phase 6 close — activity stream shipped as v0.8.2"
type: decision
status: "Accepted"
date: 2026-05-13
---

## Context

Phase 6 (Activity Stream + diagnostics, per ADR-019) opened 2026-05-12 and
closed today with v0.8.2. The phase took four small PRs over two
sessions (#55 → #59) and shipped against the v0.7.0 baseline. What
landed:

- **v0.8.0** — three-PR slice. PR #55 built `ActivityLog` types +
  `JsonActivityLog` persistence (rolling 1000-entry cap per ADR-019 D4).
  PR #56 wired emission seams across every event-emitting subsystem
  (organization watcher, transaction log, suggestion apply/skip paths,
  undo modal, autoindex). PR #57 added the `ActivityView` side panel
  with 6 filter chips + `activityLogEnabled` settings toggle.
- **v0.8.1** — diagnostics command (PR #58). New `diagnostic` event
  kind extended the v0.8.0 taxonomy (per ADR-019 D2's "future kinds
  extend the union" allowance). `Sagittarius: Run diagnostics`
  gathers every subsystem's state, prints a System-Check-style
  multi-line report to console, records a single `diagnostic`
  breadcrumb in the activity stream, and opens the activity view.
  Closes ADR-018 lesson 3 — "DevTools eval doesn't scale."
- **v0.8.2** — Phase 6 close (this PR). Adds a "Last 24h" filter chip
  to the activity view + a `Clear filtered` bulk op + extends
  `ActivityLog` with `clearMatching({kinds?, sinceMs?})`. Phase 6
  retrospective ADR (this doc). Version bump + release.

Test count grew from 592 (start of phase) to 606, all green.
Substrate adds: `src/activity/` (3 files), `src/diag/OrganizationDiagnostics.ts`,
`src/views/ActivityView.ts`. Settings gained one toggle
(`activityLogEnabled`). No new agent-facing tools per ADR-019 D7.

## The two lessons of Phase 6

### 1. "Optional dep" parameter sprawl needs a single seam

PR #56 added an `activityLog?: ActivityLog` field to every subsystem
that emits — `OrganizationWatcher`, `JsonTransactionLog`,
`UndoConfirmModal`, plus inline calls in `main.ts` for apply/undo/index
paths. Every emission site became
`this.activityLog?.record({...})`. Functionally correct, locally
trivial, but it spreads the dep across five files and two interface
contracts. Future probes (curator hits in Phase 7, MCP tool calls in
Phase 6.5) will keep adding emission sites; the surface area grows
linearly with subsystems.

**Lesson:** when an infrastructure capability is consumed by
many-and-growing call sites, prefer **one** seam — a global emitter
or context object — over **many** optional deps. The Phase 4 write
layer got this right (every write routes through
`ApprovalGate` + `TransactionLog`); Phase 6 should have done the same.
Phase 7+ refactor: introduce a `ActivityEmitter` service plugged in at
plugin-load and exposed via `this.plugin.activity`. Subsystems call
`plugin.activity.record(...)` directly rather than receiving the dep
through their constructor. Won't change behavior — just stops the
sprawl before it gets worse.

### 2. The "obsidian" import is poison to vitest — extract pure helpers early

PR #57's first test commit failed CI because `ActivityView.ts` imports
`ItemView` from `obsidian`, and vitest can't resolve `obsidian` (it's
.d.ts-only at runtime). The view's pure helpers
(`summarize`, `pathOf`, `formatRelative`, `KIND_GLYPHS`) were
trapped inside the same file, so the test couldn't import them. Fix
was to move helpers to `src/activity/format.ts`, leaving the view as
a thin `ItemView` shell. Cost: one extra file + one rerun.

This is a generalizable pattern. Every Obsidian-backed view has
*some* pure logic (rendering text, formatting numbers, filtering
data). That logic should live in a sibling module that imports zero
runtime `obsidian` symbols. Same trap was hit in v0.4.1 with `TFile`
(see ADR-018 lesson recap). Two strikes; time for a rule.

**Lesson:** when adding an ItemView / Modal / SettingTab, scaffold
its pure helpers in a non-Obsidian-importing sibling file from the
start. Cheap upfront, expensive to retrofit when tests are failing
on PR open.

## Decision

Mark Phase 6 done. Update `CLAUDE.md` phase map. Phase 6.5 (MCP
bridge, split from this phase per ADR-019 D1) becomes the next
phase to ADR-draft if Thad wants to ship it before Phase 7. Phase 7
(Curator) is the alternative.

Carry the two lessons above as guardrails for Phase 7+:

1. Pre-ADR'd phases that touch many subsystems get a single
   emitter seam, not per-subsystem optional deps.
2. Every new view / modal / setting-tab ships with its pure helpers
   already extracted to a non-Obsidian-importing module.

## Follow-ups (carry into Phase 6.5 / Phase 7)

- **ActivityEmitter refactor** — fold `this.activityLog` accesses
  into `this.plugin.activity.record(...)` calls; deprecate the
  per-subsystem `activityLog?` constructor field. Should land before
  the curator agent adds its own emission sites.
- **Activity event compaction** — `classifier.ran` events fire on
  every sweep tick. At 30s background sweep + 50 inbox notes that's
  ~144k events/day. The 1000-entry cap prevents disk bloat but a
  "rolled-up" view kind (`classifier.summary` with hourly buckets)
  would be more useful for actual review.
- **Auto-refresh** — the activity view re-renders on `refresh()`
  call from main.ts, but the user has to click Refresh to see
  background-sweep events. A 5-second poll on the open view (or a
  vault-event tap) would close the gap cheaply.
- **MCP bridge** (Phase 6.5) — ADR-019 split this from Phase 6.
  Still no ADR drafted. Decide whether to ship it before Phase 7 or
  fold into Phase 7's curator-agent ADR.

## Related

- [ADR-019](2026-05-12-adr-019-phase-6-plan.md) — Phase 6 plan; this
  ADR closes the loop on D6's three-version rollout.
- [ADR-018](2026-05-12-phase-5-close.md) — Phase 5 retrospective;
  lesson 3 (diagnostics) was the direct driver of Phase 6.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan;
  TransactionLog seam (touched in PR #56) honors ADR-016 D2.
- [ADR-010](2026-05-04-sagittarius-build-process.md) — process; this
  retrospective closes the Phase 6 PRs per §4.
