---
title: "ADR-029: Phase 9 plan — Memory layer (CLAUDE.md cascade)"
type: decision
status: "Accepted (D1-D10 batch-accepted 2026-05-14)"
date: 2026-05-14
---

## Context

Spec §11 calls for a "memory layer" — durable context the agent can
read at every turn without the operator pasting it each time. Phase
8 closed (ADR-028) with `_drafts/` quarantine + cited drafting; the
next gap is operator memory: facts, conventions, project-specific
guidance that should live in the vault and reach the agent's system
prompt automatically.

Three architectural shapes are possible (per the morning's planning
conversation with Thad):

1. **CLAUDE.md cascade.** Vault-root `/CLAUDE.md` plus optional
   per-folder `<folder>/CLAUDE.md` files load automatically into
   the agent's system prompt at every chat turn. Same mental
   model as Claude Code's project-level `CLAUDE.md`. **(Selected.)**
2. **Structured dossiers.** `memory/people/X.md`, `memory/projects/
   Y.md` with mandatory frontmatter; agent reads via tool calls.
3. **Both.** CLAUDE.md for general guidance + dossiers for
   entity-specific context.

Thad selected **(1)** for Phase 9 MVP. Dossiers can come in Phase
9.x or as Phase 10 if the cascade proves insufficient. Loading is
**always-on system-prompt injection** (no `read_memory` tool call);
**writes reuse existing `append_to_note` / `patch_note`** (no new
`remember` tool) per ADR-028 lesson 2 (compose existing primitives).

This ADR is the Phase 9 plan. Decisions D1-D10 below await batch
acceptance per the ADR-026 pattern. Same-day implementation per
ADR-010 §4 once accepted.

## Goals

- Operator writes long-lived context to `/CLAUDE.md` and (optionally)
  `<folder>/CLAUDE.md` files in their vault.
- Sagittarius loads them at every chat turn — no extra ceremony.
- The cascade is **deterministic** (root → folder), **bounded**
  (size budget), **visible** (operator can see what loaded), and
  **edit-friendly** (re-reads from disk so saves take effect
  immediately).
- Zero new write tools; the agent proposes memory edits via
  existing tools through the existing diff card.

## Decisions

### D1. Filename: `CLAUDE.md` (verbatim).

**Selected:** `CLAUDE.md` — case-sensitive, no extension variation.
Familiar to anyone using Claude Code. The plugin SHOULD NOT pick up
`claude.md`, `Claude.md`, `agents.md`, or `CLAUDE.MD`; the case is
the contract.

**Rationale:** the filename IS the protocol. A configurable filename
multiplies test surface area without paying for itself; an operator
who wants a different name can symlink. **Not configurable.**

### D2. Cascade: root + active-file ancestor chain.

**Selected:** load **every** `CLAUDE.md` from the vault root down
through every ancestor folder of the currently-active file, then
the active file's own folder. ESLint-style cascade. Concatenate
root-first.

**Example:** active file `30-Projects/sagittarius/notes/2026-05-14.md`
loads:
1. `/CLAUDE.md` (root)
2. `30-Projects/CLAUDE.md` (if exists)
3. `30-Projects/sagittarius/CLAUDE.md` (if exists)
4. `30-Projects/sagittarius/notes/CLAUDE.md` (if exists)

Missing files are skipped silently. No file is required.

**Why ancestor cascade and not just root + immediate parent:** the
folder hierarchy IS the namespace. A user who organizes notes under
`30-Projects/sagittarius/` should be able to put project-specific
guidance at `30-Projects/sagittarius/CLAUDE.md` without it polluting
sibling projects. Walking the chain is one extra `exists()` per
ancestor — bounded by folder depth (≤10 in practice).

**When no file is active:** only the root `CLAUDE.md` loads. No
guessing.

### D3. Concatenation format.

**Selected:** each loaded file becomes a labeled section in the
system prompt:

```
# Memory: vault-root CLAUDE.md
<contents>

# Memory: 30-Projects/CLAUDE.md
<contents>

# Memory: 30-Projects/sagittarius/CLAUDE.md
<contents>
```

The header tells the model where each chunk came from so it can
weigh specificity ("the project-level convention overrides the
vault-level one"). Headers are stable text — cache-friendly.

### D4. Size budget: 50KB total, soft truncation.

**Selected:** total memory injected per turn capped at **50KB**
(roughly ~12K tokens). When the cascade exceeds the cap:

- Load files in order (root → most-specific).
- After each file, if running total > 50KB, **truncate the
  current file at the byte boundary** and append the literal
  string `\n\n... [truncated for memory budget] ...\n`.
- Skip remaining files (rare; only when total budget is already
  blown by the time we hit a specific folder).
- Emit a `Notice` once per session: "Sagittarius: memory budget
  exceeded — truncating. Tighten `CLAUDE.md` files or raise the
  budget in Settings."

**Why soft truncation and not hard reject:** the operator probably
typed those bytes deliberately; truncating gives them *something*
while signaling the issue. Hard reject would be silent UX failure.

**Configurable** via `memoryMaxBytes` setting (default 50_000).

### D5. Always-on injection, between THAD_MAN and the rest.

**Selected:** the system prompt order becomes:

1. THAD_MAN.md (constitution — unchanged)
2. **Memory cascade (new — D2 + D3)**
3. concierge.md (Hangar voice — unchanged)
4. Tool definitions (unchanged)

THAD_MAN sets the meta-rules; memory provides operator context;
concierge sets the voice. Memory between constitution and voice
matches the natural priority ordering.

**Cache_control:** the memory section gets its own cache breakpoint
*alongside* the existing THAD_MAN / concierge breakpoint. When
operator edits `CLAUDE.md`, only the memory cache invalidates; the
constitution cache survives. (Anthropic SDK supports multiple
breakpoints — we already use one for THAD_MAN.)

### D6. Refresh strategy: read on every chat turn.

**Selected:** the cascade re-reads from disk at every `ConduitAgent.chat()`
invocation. No in-memory caching at the plugin layer; the model
boundary's `cache_control` handles efficient transport.

**Why not cache in memory:** vault files are small (KB), reads are
cheap, and operators expect "I saved CLAUDE.md, the next message
uses it." Caching in memory adds invalidation complexity (vault
event subscriptions, race conditions on rapid edits) for negligible
performance gain — disk I/O is dwarfed by network I/O to the API.

### D7. UI indicator: status bar pill + chat-response footer.

**Selected:** two surfaces:

1. **Status bar pill:** always-visible pill ("Sagittarius:
   memory N.NKB" or "memory off") that lives alongside the drafts
   pill. Click opens a modal listing every CLAUDE.md the plugin
   would load if you sent a message NOW (per current active file).
   Hides when no `CLAUDE.md` files exist anywhere in the vault.
2. **Chat response footer:** each turn's response footer gains
   one line: `memory: 2.1KB from /, 30-Projects/` (a compact
   list of which files contributed). When empty: `memory: none`.

**Why two surfaces:** the pill is the "what would happen now"
preview; the footer is the "what happened on this turn" receipt.
Together they answer "did the agent see X?" without scrolling
through transcripts.

### D8. Writes: reuse `append_to_note` and `patch_note`.

**Selected:** zero new write tools. When the agent learns
something durable, it proposes:
- `append_to_note(path='CLAUDE.md', content=...)` to add to root
  memory
- `patch_note(path='30-Projects/CLAUDE.md', ops=[...])` to refine
  folder-level memory
- `create_note(path='30-Projects/CLAUDE.md', content=...)` to
  bootstrap a new folder's memory

The diff card per ADR-016 D2 gates every memory edit — same flow
as any other vault write. The operator sees the proposed CLAUDE.md
change before it commits.

**No "auto-remember" in this phase.** The agent doesn't decide
unilaterally to record something; it proposes through the regular
tool flow. ADR-024 lesson 1 ("auto-anything earns trust slowly")
applies — let the operator approve each memory write while we
calibrate what's worth remembering.

### D9. System-prompt-only injection — no agent visibility.

**Selected:** memory IS the system prompt. The agent doesn't get
a separate "memory" channel, doesn't query memory via tools,
doesn't see memory file paths as first-class entities. From the
agent's perspective, the contents of CLAUDE.md are indistinguishable
from THAD_MAN.md — just durable context the operator wrote.

**Why this matters:** keeping memory in the system prompt means it
benefits from cache_control efficiency, doesn't pollute the chat
transcript, and stays out of the tool-use loop's token budget. The
trade-off is the agent can't *introspect* what it remembered — but
the operator can (via D7 surfaces), which is what actually matters.

### D10. Ship plan: MVP at v1.3.0, Phase 9 close at v1.3.x.

**Selected:** **v1.3.0** ships the MVP — cascade discovery, system
prompt injection, status bar pill + footer, settings toggle, full
test suite. **Phase 9 stays open** at v1.3.0 with an ADR-028-style
close coming as v1.3.x (or later) once we learn from real-world use
whether the cascade behavior matches operator intent.

Tonight's session: ADR-029 (this doc) + MVP slice. Close + Phase 9
retrospective happens in a future session after the cascade has
been exercised.

## Risks / open questions

- **OQ1:** does the cascade interfere with prompt caching efficiency
  when operators edit CLAUDE.md mid-session? D5's separate cache
  breakpoint mitigates but the THAD_MAN cache still has to survive
  CLAUDE.md edits — verify in implementation.
- **OQ2:** size budget of 50KB is a guess. If real operators blow
  through it, raise the default; if nobody comes near, tighten.
  Defer to telemetry after a week of use.
- **OQ3:** is "active file" the right cascade anchor? When the
  operator runs `Sagittarius: Quick question` from Cmd+P with no
  file active, we fall back to root-only. Is that surprising? Defer
  to v1.3.x once observed.

## Related

- [ADR-028](2026-05-14-phase-8-close.md) — Phase 8 close; lesson 2
  ("reuse existing primitives") is the architectural reason D8
  ("zero new write tools") is the right call.
- [ADR-024](2026-05-14-phase-7-close.md) — Phase 7 close; lesson 1
  ("auto-anything earns trust slowly") is why D8 doesn't include
  auto-remember.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 ("every write
  through the diff card") — the constraint memory writes inherit.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then same-day implementation.
- Spec §11 — "Memory layer" requirement this phase satisfies.
