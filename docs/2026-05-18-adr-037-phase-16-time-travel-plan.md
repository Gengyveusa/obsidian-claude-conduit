---
title: "ADR-037: Phase 16 plan — Time-travel queries (v2.0)"
type: decision
status: "Proposed (D1-D10 await batch acceptance)"
date: 2026-05-18
---

## Context

Phases 12-15 (all shipped today) made memory mutual, conversations
durable, the curator proactive, and the agent adversarial. **Phase
16 inverts the index itself**: from current-state-only (today's
snapshot of every chunk) to **temporal** (query the vault AS-IT-
EXISTED at any past git commit).

This is the fifth and final holy-shit move per ADR-031, and the
roadmap explicitly flagged it as the v2.0 architectural pivot
(ADR-031 D1 + OQ3): the SQLite engine's schema changes, every
consumer of `chunks` needs to reckon with a `commit_sha` column,
and the index moves from a single snapshot to a versioned artifact.
Worth a major bump.

The use cases this unlocks:

> *"What was I thinking about Soltura in February?"* — query the
> agent against the vault's February state; cite notes as they
> existed then; surface ideas that have since been deleted or
> rewritten.

> *"How has my thinking on FortressFlow evolved across Q3?"* — agent
> samples three snapshots over the quarter, contrasts the framing
> at each point.

> *"Replay my reasoning before I made the wrong call on X"* —
> query the vault state just before a decision; understand what
> data the past-you actually had to work with.

Combined with Phase 13 (conversational notes durable) and Phase 12
(reverse-memory journals), Phase 16 produces **longitudinal
self-reflection at a fidelity no operator has had access to before.**

This ADR follows the established plan-ADR template (ADR-026, 029,
032, 033, 034, 035, 036). 10 decisions, batch-accept, same-or-next-
session implementation per ADR-010 §4. Bigger scope than prior
plans — 2-3 sessions of implementation expected.

## The inversion

| Mode | Index state |
|---|---|
| `chat` / `vault-qa` / `negotiate` | Current state only |
| **`time-travel`** *(new)* | **Vault state at chosen past commit** |

## Goals

- **Query past vault state** via a chosen git commit or date
- **Cited responses reference the historical chunk** + the snapshot date
- **Storage stays bounded** — not every commit is snapshotted; the
  operator (or scheduled job) curates which commits matter
- **Write-blocking** in time-travel mode — operator can only READ
  the past
- **Migrate cleanly** — existing single-state installs upgrade
  without losing their current index

## Decisions

### D1. Require a git-tracked vault — gracefully disable if not present.

**Selected:** Phase 16 features check for `.git` at the vault root
on plugin load. If absent, the time-travel mode is hidden from the
dropdown + the snapshot command shows a one-time Notice: *"Time-
travel needs git. Run `git init` in your vault to enable past-
state queries."*

**Why require git:** the whole point is replaying past vault
states; without git history, "past state" is undefined. Tying to
git (rather than building our own snapshot tool) leans on existing
infrastructure operators already use.

**Risk:** operators without git lose access to the feature. But
the operator who wants longitudinal reflection is exactly the
operator already running git on their vault. Acceptable.

### D2. Storage: single chunks table + `commit_sha` column (not per-commit DBs).

**Selected:** the existing `chunks` table gains a `commit_sha`
column (text, nullable for legacy single-state rows). One row per
(notePath, chunkIndex, commit_sha) tuple. A query at commit X
filters `WHERE commit_sha = ? OR commit_sha IS NULL` (the NULL
case is the current-state index, preserved for back-compat).

**Why not per-commit DBs:** filesystem fragmentation, harder to
query across snapshots, deduplication impossible. Single table +
index lets SQL handle the temporal join naturally.

**Index on `(notePath, chunkIndex, commit_sha)` and `(commit_sha)`**
to keep both forward (chunks for a path at a commit) and reverse
(everything in a snapshot) queries fast.

### D3. Snapshot trigger: manual command + automatic on git tags.

**Selected:** two paths feed snapshots into the index:

- **Manual:** `Sagittarius: Snapshot vault for time-travel`. Reads
  the current git HEAD, indexes every note's chunks with
  `commit_sha = <HEAD-sha>`. Idempotent (skips if a snapshot for
  the SHA already exists).
- **Automatic on tag push:** when the operator pushes a git tag,
  the plugin (via vault file-watch on `.git/refs/tags`) auto-
  snapshots the tagged commit. This produces a curated set of
  "named moments" (releases, decisions, milestones).

**Why NOT every-commit auto-indexing:** an operator with 1000
commits = 1000 × current-index-size in storage. Too expensive.
Tag-based + manual lets the operator choose what's worth
preserving.

**Follow-up slot for v2.0.x:** scheduled daily snapshots
(`timeTravelDailySnapshot: bool`) for operators who want
unattended coverage.

### D4. Retention: keep tagged snapshots forever, expire others by age.

**Selected:** garbage-collection policy:

- **Tagged commits** — kept indefinitely (operator deliberately
  marked them).
- **Untagged manual snapshots** — expire after
  `timeTravelRetentionDays` (default 365). Operator can promote a
  snapshot to permanent via `Sagittarius: Pin snapshot
  <commit-sha>` (sets `pinned: true` in the snapshot metadata).
- **Current-state index** (commit_sha IS NULL) — never expires.

GC runs on a slow schedule (once per plugin load if `>24h` since
last GC). Deletes chunks with expired `commit_sha`s; reclaims
sqlite space.

### D5. Schema migration: bump `schema_version` to 2.0 — auto-migrate on load.

**Selected:** the existing `chunks` table is ALTERed on plugin
load to add `commit_sha TEXT NULL` (default NULL = current state).
Existing rows preserve their meaning; new code reads `commit_sha
IS NULL` as "current snapshot".

Schema version bumps from `1.x` to `2.0`. Pre-2.0 installs run
the migration once; future loads see the migration is already
applied.

**Failure mode:** if the ALTER fails (rare; sqlite supports it),
the plugin falls back to read-only mode for retrieval + logs a
warn. Operator can wipe + rebuild.

### D6. UX: new chat mode `'time-travel'` + snapshot picker.

**Selected:** the ChatView mode dropdown gains a fourth option:
"Time-travel". Selecting it opens a snapshot picker modal:

```
Pick a snapshot to query against:

  ○ Current (default) — today's vault
  ○ 2026-05-15  tagged: v1.5.0
  ○ 2026-04-12  manual snapshot
  ○ 2026-03-01  tagged: q1-decisions
  ○ Custom date — pick from calendar
```

Operator picks; modal closes; ChatView header shows a permanent
banner: *"Time-travel mode — querying vault as of 2026-04-12.
Switch mode to exit."* Chat responses cite chunks + show their
historical date.

**Date → commit resolution:** for "custom date" picks, the plugin
finds the closest tagged-or-pinned snapshot ≤ that date.
Granularity = the operator's snapshot cadence.

### D7. Write-blocking in time-travel mode.

**Selected:** when `mode === 'time-travel'`, the agent's write
tools (`create_note`, `patch_note`, `append_to_note`, etc.)
short-circuit with an error: *"Time-travel mode is read-only — you
can't edit the past. Switch mode to make changes."*

Enforcement at the ToolRegistry level (not the prompt) so a
confused agent can't accidentally propose a write the operator
might mis-accept.

Phase 12 journal + Phase 13 chat-note commands also disable in
time-travel mode (saving a journal "as of February" is nonsense).

### D8. Citation format: link + historical date suffix.

**Selected:** when citing in time-travel mode, the agent renders
`[[note-path]] (as of 2026-04-12)`. Obsidian renders the wikilink
to whatever the path resolves to TODAY (the historical content
might not be reachable via the live note); the suffix tells the
operator the cited chunk's vintage.

The chat-response footer also surfaces the active snapshot date so
the operator can't lose track of which era they're querying.

**Limitation acknowledged:** Obsidian's metadata cache + backlink
graph reflect current state. Time-travel cites historical chunks
but Obsidian can't "open" a deleted/renamed-since note from the
wikilink alone. v2.0.x can add a "preview historical content"
modal that shows the chunk text from the snapshot.

### D9. Memory cascade behavior in time-travel mode.

**Selected:** the CLAUDE.md cascade (Phase 9) and journal cascade
(Phase 12) **stay current** in time-travel mode. The agent reads
TODAY's house rules + journals, queries PAST chunks. This matches
operator intent: *"What did I think about X then, given who I am
now."*

**Rationale:** flipping the cascade to historical state introduces
combinatorial confusion (was this CLAUDE.md rule even in effect
then?). Current-cascade + past-chunks is the cleaner mental model.

OQ3 in this ADR (below) flags this as worth revisiting if real-
use shows operators want historical CLAUDE.md too.

### D10. Ship plan — MVP at v2.0.0; v2.0.x follow-ups; close ADR after ~10 snapshots.

**Selected:**

**v2.0.0 MVP (2-3 sessions):**
- Schema migration (`commit_sha` column + indexes)
- `Sagittarius: Snapshot vault for time-travel` command
- Snapshot retention + GC (basic; tag-permanent / age-based)
- `mode: 'time-travel'` in ChatView with snapshot picker modal
- Banner + write-blocking + citation date-suffix
- Settings: `timeTravelEnabled` (opt-in, default false),
  `timeTravelRetentionDays` (365)
- Tests: ~60 (the biggest test surface of any phase)

**v2.0.x follow-ups (named slots per ADR-030 lesson 1):**
- **v2.0.1** — auto-snapshot on git tag push (D3 second path; needs
  vault file-watcher on `.git/refs/tags`)
- **v2.0.2** — `timeTravelDailySnapshot` setting for unattended
  coverage
- **v2.0.3** — "Preview historical content" modal (D8 limitation
  hedge)
- **v2.0.4** — "Diff between snapshots" command (show what changed
  in a note between two snapshots)
- **v2.0.5** — `Sagittarius: Pin snapshot` command for promoting
  ad-hoc snapshots to permanent

**Phase 16 close ADR** after operator has used time-travel for
~10 distinct queries across ~2 weeks. Lessons go in there.

**Phase 16 also closes the ADR-031 roadmap.** All five holy-shit
moves shipped. A summary "ADR-038: roadmap close" can recap +
chart what comes after v2.0.

## Risks / open questions

- **OQ1: Storage cost.** A medium vault (10K notes, ~50K chunks)
  × ~12 monthly snapshots = ~600K rows. Manageable. But operators
  with 100K+ notes + heavy snapshot rates could hit GBs. The
  retention policy (D4) bounds this; v2.0.x can add per-snapshot
  size caps if needed.
- **OQ2: "What does 'today' mean in time-travel mode?"** When the
  agent in time-travel mode references "today's plan", does it
  mean the snapshot date or the real wall-clock today? D8's banner
  tells the operator what the active date is; the agent's system
  prompt should clarify: "You're querying state as of 2026-04-12.
  References to 'now' / 'today' should respect this." Flagging for
  the implementation phase.
- **OQ3: Historical CLAUDE.md cascade.** D9 chose current-cascade.
  Real-use may reveal operators want historical cascade for full
  "past-self" simulation. Defer to v2.0.x.

## Related

- [ADR-031](2026-05-15-adr-031-roadmap-phases-12-16.md) — roadmap;
  Phase 16 scope provisionally outlined as the v2.0 architectural
  pivot; OQ3 of that ADR flagged that Phase 16 might warrant its
  own architectural ADR ahead of the plan. This document combines
  both — the architectural decisions (D1-D5) precede the user-
  facing decisions (D6-D10). If implementation reveals the schema
  + GC + git-events surface needs more design, we can split into a
  separate ADR-038 substrate later.
- [ADR-029](2026-05-14-adr-029-phase-9-memory-plan.md) — Phase 9
  memory layer; D9 above interacts with the CLAUDE.md cascade
  established here.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 (every write
  through the diff card); D7 above extends this with "no writes
  in time-travel mode" (the diff card never even surfaces).
- [ADR-024](2026-05-14-phase-7-close.md) — lesson 1 (auto-anything
  earns trust slowly) — D3's manual-command-first / auto-on-tag-
  second cadence honors this.
- [ADR-028](2026-05-14-phase-8-close.md) — lesson 2 (compose
  existing primitives) — Phase 16 adds new write surface (snapshot
  command) but reuses retrieval + ChatView mode plumbing.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then implementation across 2-3
  sessions.

## Note on the "zero new write tools" streak

Phases 9 → 15 + ADR-032 token slots = **eight phases of "zero new
write tools" in a row.** Phase 16 may break this streak:

- The snapshot command writes index rows (DB-level write, not vault-
  level). Arguably this isn't a "write tool" in the ADR-016 D2
  sense (no markdown bytes hit the vault), but it's worth being
  honest in the close ADR.
- If the v2.0.x "Pin snapshot" command requires markdown metadata
  somewhere, that's a real new write surface — and it should route
  through the diff card.

The discipline is "don't add new write tools for things existing
tools can do." Phase 16's new write surface (the snapshot DB
operations) is genuinely new functionality. Acceptable.
