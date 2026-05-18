---
title: "ADR-036: Phase 15 plan — Negotiation mode (v1.8.0)"
type: decision
status: "Proposed (D1-D10 await batch acceptance)"
date: 2026-05-18
---

## Context

Phases 12-14 (just shipped) made memory mutual, conversations
durable, and the curator proactive. Phase 15 inverts the **agent's
posture**: from supportive ("here's evidence for your thesis") to
**adversarial** ("here's the strongest case against your thesis,
drawn from your own vault").

This is the fourth holy-shit move per ADR-031. The whole point: when
you're about to commit to a direction, you tell Sagittarius your
thesis, switch to negotiate mode, and the agent argues back using
notes YOU wrote earlier. Anti-buzzword by construction — you can't
bullshit yourself when your own past notes are arguing back.

Per ADR-031 D6 recommended scope: new chat mode, system prompt
addendum, optional retrieval pivot (semantic-opposite ranking;
deferred to v1.8.x), UI banner.

This ADR follows the established plan-ADR template (ADR-026, 029,
032, 033, 034, 035). 10 decisions, batch-accept, same-session
implementation per ADR-010 §4.

## The inversion

Today's chat modes:
- **chat** — agent helps; cites when relevant; assumes operator is right
- **vault-qa** — agent answers strictly from vault; cites everything; still aligned with operator's framing

After Phase 15:
- **negotiate** — agent **disagrees**; finds counter-evidence in the operator's own notes; the harder, the better

The vault becomes a Greek chorus of past-yous arguing with present-you.

## Goals

- **One new chat mode** — joins `chat` / `vault-qa` in the existing dropdown
- **Adversarial system prompt** — explicit "find counter-evidence from this operator's notes"
- **Cited counters** — every objection backed by a `[[note]]` link
- **Visible banner** — operator always knows when the agent is in negotiate posture
- **MVP via prompt only** — semantic-opposite retrieval deferred to v1.8.x (heavier; needs new index machinery)
- **Zero new write tools** — eight phases of this discipline in a row

## Decisions

### D1. New chat mode `negotiate` joins `chat` / `vault-qa` in the dropdown.

**Selected:** `ChatView.mode` type becomes
`'chat' | 'vault-qa' | 'negotiate'`. The dropdown adds a third
option labeled "Negotiate". Mode is per-session (set when the chat
panel opens; persists for that conversation).

**Why a third mode (not a separate command):** consistency with the
existing pattern. ChatView already has a mode dropdown; operators
know where to look. Per-session granularity matches how
conversations actually happen — you commit to the negotiate posture
for a focused argument, not for one turn.

`draft-refine` stays per-call (auto-detected from active file per
ADR-026 D5(d)+D6(c)). Negotiate is operator-selected because it's
not detectable from context — the operator picks when to be argued
with.

### D2. System prompt addendum — explicit adversarial instructions.

**Selected:** when `mode === 'negotiate'`, `ConduitAgent.buildSystemPrompt`
appends this block (between `modeAddendum` and any retrieved context):

```
Mode: NEGOTIATE. Your role this turn is to find the STRONGEST
counter-evidence to the operator's stated position, drawn from
their own vault notes.

- Read the operator's thesis from their first message (or restated
  thesis on later turns).
- Use search_vault aggressively to find notes that contradict,
  complicate, or undermine the thesis.
- Cite every counter with [[note-path]] wikilinks. Counters
  without citations are speculation — skip them.
- Be direct. "Your past note X argues Y, which contradicts Z."
  Not "you might want to consider..."
- Refuse to flatter. Refuse to soften. The operator chose this
  mode specifically to be challenged.
- If you can't find counter-evidence in the vault, say so:
  "I searched for X / Y / Z and found nothing in your vault that
  contradicts this. The thesis may be uncontested in your
  written record (which is itself worth noting)."
```

The block is per-turn (no `cache_control`) so it can be added
unconditionally without invalidating the cached constitution
prefix.

### D3. Thesis source — first user message of the session.

**Selected:** the operator's **first user message** in a negotiate-
mode session IS the thesis. No separate input field, no special
syntax. Just: switch to negotiate, type your claim, hit send.

On subsequent turns within the same session, the agent treats the
WHOLE conversation as the evolving position — newer operator
messages refine or extend the thesis; the agent continues finding
counters.

**Why not a dedicated field:** more friction, more code, no clearer
UX. The chat input is right there; just use it.

**Risk:** if the operator changes topic mid-session, the agent
might still argue against the original thesis. Acceptable for MVP;
operator can start a new session.

### D4. UI banner above the messages area.

**Selected:** when `mode === 'negotiate'`, ChatView renders a
banner above the messages list:

```
⚔ Negotiation mode — agent is arguing against your stated position
using your own vault. Switch mode in the dropdown to exit.
```

Distinct visual marker (sword emoji ⚔) so the mode is unmissable.
Same pattern as the Phase 8 draft-refine banner (ADR-026 D5(d)).
Removing the banner happens on mode change (already wired via the
dropdown handler).

### D5. Citation policy — every counter must cite.

**Selected:** the system prompt (D2) explicitly forbids uncited
counters. No new mechanical enforcement at the engine level — the
prompt + the agent's reliability + the visible banner are enough
for MVP. If real use shows the agent slipping in uncited assertions,
v1.8.x can add a post-response validator (parse the response for
counter-claims, reject ones without `[[]]` markers, retry).

Vault-qa's existing strict-citation discipline informs the prompt
wording; negotiate inherits the spirit.

### D6. Retrieval — same `vault-qa` pre-retrieval seed, prompt-only pivot.

**Selected:** MVP uses the existing `vault-qa` pre-retrieval flow
verbatim (one embedding pass on the user's message; top-K chunks
seeded into the system prompt). The "find OPPOSITE evidence" lift
happens **in the model**, not the index — the prompt tells the
model to use the retrieved chunks as raw material AND to run
follow-up `search_vault` calls with deliberately contrasting queries.

**Why not semantic-opposite ranking in the index:** that needs new
embedding machinery (negate the query vector? Cluster + pick anti-
clusters? Both unproven). Prompt-only is good enough until we see
where it fails. Deferred to **v1.8.x** as a named follow-up slot.

### D7. No new write tools — composes existing primitives.

**Selected:** negotiate mode is read-only. The agent uses
`search_vault` + `read_note` to find counters; no `create_note` /
`patch_note` / etc. Zero new write tools per ADR-016 D2 +
ADR-028 lesson 2 — **eight phases of this discipline in a row**
(Phases 9 → 14 + ADR-032 token slots + Phase 15 now).

**Operator may, of course, save the negotiation as a chat note via
Phase 13's `Sagittarius: Save this conversation as a note`.** That
write still goes through the diff card.

### D8. No new settings.

**Selected:** mode is transient ChatView state; no persistent
setting. Operators who want to start every session in negotiate
mode (rare) can pin a hotkey to a future `negotiateModeDefault`
setting (deferred to v1.8.x if anyone asks).

**Why minimal config:** consistency with `chat` and `vault-qa` —
neither has a "default this" setting. Negotiate follows suit.

### D9. ChatView wiring — minimal change.

**Selected:**

- `ChatView.mode` type extends to include `'negotiate'`
- Dropdown gains "Negotiate" option
- New `renderNegotiateBanner()` mirrors `refreshDraftBanner()` from
  v1.3.2
- Mode change handler shows/hides the banner

Pass-through to `ConduitAgent.chat()`: the existing 3rd `mode` arg
already accepts a string; widening the type at the seam is the only
change there.

**Test surface:** ChatView mode-change behavior + ConduitAgent
system-prompt assembly when mode is negotiate. Pure-module tests for
the prompt-text generation are simplest.

### D10. Ship plan — MVP at v1.8.0, named follow-ups as v1.8.x.

**Selected:**

**v1.8.0 MVP (this session if time allows; else next):**
- `mode: 'negotiate'` type extension in ConduitAgent + ChatView
- System prompt addendum (D2)
- Dropdown option + banner UI (D4, D9)
- Tests: ~15 across prompt assembly, mode dropdown, banner toggle

**v1.8.x follow-ups (named slots per ADR-030 lesson 1):**
- **v1.8.1** — semantic-opposite retrieval (the harder retrieval
  pivot deferred from D6); needs new index machinery
- **v1.8.2** — citation enforcement (post-response validator that
  rejects uncited counter-claims and retries once)
- **v1.8.3** — soft-refusal for sensitive theses ("I won't argue
  against your stated boundaries" detection — operator picks the
  taxonomy)
- **v1.8.4** — `negotiateModeDefault` setting if anyone asks

**Phase 15 close ADR** after operator has run ~5 negotiations.
Lessons go in there.

## Risks / open questions

- **OQ1:** the agent might sandbag — find weak counters or qualify
  them so heavily they don't bite. The system prompt explicitly
  forbids softening, but model behavior under "be adversarial"
  instructions is genuinely variable. Verify in real use.
- **OQ2:** for theses with no vault context (operator's first time
  thinking about X), the agent has nothing to argue with. D2's
  "I found nothing in your vault that contradicts this" fallback is
  honest but feels like a feature gap. Acceptable; v1.8.x could
  fall back to general-knowledge counter-evidence (clearly marked
  as such) if operators want it.
- **OQ3:** sycophancy might leak through ("Great thesis! Here's
  why it's wrong: …"). Phase 12's "no flattery in operator-facts"
  prompt discipline is the template; D2's wording mirrors it.
  Verify in real use.

## Related

- [ADR-031](2026-05-15-adr-031-roadmap-phases-12-16.md) — roadmap;
  Phase 15 scope provisionally outlined; this ADR is the binding
  plan.
- [ADR-026](2026-05-14-adr-026-phase-8-generative-layer-plan.md) —
  Phase 8 plan; D5(d)+D6(c) draft-refine banner pattern is the
  template D4+D9 follow.
- [ADR-033](2026-05-15-adr-033-phase-12-reverse-memory-plan.md) —
  Phase 12 plan; D4's anti-sycophancy prompt language is the
  template D2 mirrors.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 (every write
  through the diff card) is the constraint; negotiate mode is
  read-only so it inherits trivially.
- [ADR-024](2026-05-14-phase-7-close.md) — lesson 1 (auto-anything
  earns trust slowly) — negotiate is operator-explicitly-opted-in
  per turn-cycle, no auto-trigger.
- [ADR-028](2026-05-14-phase-8-close.md) — lesson 2 (compose
  existing primitives) — D7 honors this.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then same-session implementation.
