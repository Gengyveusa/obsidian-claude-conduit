---
title: "ADR-026: Phase 8 plan — Generative layer (cited drafts + proposal quarantine)"
type: decision
status: "Draft — awaiting Thad's sign-off"
date: 2026-05-14
---

## Context

Spec §10 names Phase 8 as the **generative layer**: Sagittarius
produces cited drafts of new vault content, and all generative output
flows through a proposal-quarantine before reaching the canonical
vault.

Today (post-v1.0.7), Sagittarius is *responsive*: chat, retrieval,
write tools, curator, MCP bridge. Every word that lands in a note was
either typed by the user or proposed by Claude in response to a
specific user instruction. The agent doesn't write on its own.

Phase 8 changes that. After Phase 8:

  - User can ask "draft a one-pager on the Q3 roadmap" and Claude
    produces a full markdown note, cited block-by-block from vault
    chunks (and optionally external sources).
  - Curator-style proactive prompts may surface: "you have three
    meeting notes about the migration but no synthesis — draft one?"
  - Every generative output is **quarantined** by default. It lives
    in a `_drafts/` namespace where the LLM wrote it; promotion to
    the canonical vault is an explicit user act gated by the
    Phase 4 diff card.

**Why quarantine matters.** The vault is the system of record
(THAD_MAN.md §1). The Phase 4 diff card already gates *modifications*;
Phase 8 generative output is new content **without explicit user
authorship**. Quarantine is the seam between "LLM thought" and
"user-endorsed thought." Without it, generative drift contaminates
the vault's epistemics — every retrieval starts looking like a
synthesis of prior syntheses.

**Why cited drafts matter.** Sagittarius's read layer (Phase 3)
returns chunks with provenance. Phase 8 generative output should
*propagate* that provenance. Every paragraph of a draft has a
citation list pointing back at the chunks that grounded it. The user
can audit the draft by checking sources before promoting.

**The ADR-024 cross-reference.** v1.0.7 shipped the duplicate-merge
combo: `patch_note` + `delete_note`. Phase 8's draft-promotion path
should ideally share machinery with that combo — a draft is a
prospective `create_note` proposal, and promotion is approving it.
Decision D9 below explores whether to unify these or keep them
separate.

This is the largest of the post-v1.0 phases. Decisions below aim to
ship a minimal viable generative layer at v1.2.0, leaving more
sophisticated workflows (collaborative drafting, multi-section
weaving) for v1.3+.

---

## Decisions

### D1 — Draft storage location

Drafts need a vault-visible home so the user can read/edit them in
Obsidian, but they need to be **clearly demarcated** as non-canonical.

**(a) `_drafts/` folder at vault root.** All drafts pool here.
Easy to enumerate. **Con:** flat — finding "drafts about Q3" means
grepping titles.

**(b) `_drafts/<topic-folder>/` mirroring the canonical folder
structure.** A draft destined for `10-Inbox/foo.md` lives at
`_drafts/10-Inbox/foo.md`. Promotion = move out of `_drafts/`.
**Pro:** parallel structure makes destination obvious. **Con:**
duplicate folder tree.

**(c) Quarantine outside the vault — a JSON-persisted draft store.**
Drafts live in plugin data; surfaced via a Drafts side panel only.
**Con:** breaks the "vault is the system of record" principle —
drafts that are *almost* records but not quite.

**(d) Tag-based quarantine: drafts live in their final location but
carry `quarantined: true` frontmatter.** Promotion = remove the tag.
**Con:** retrieval would have to filter quarantined notes everywhere.

`<DECISION D1: PROPOSED — (b) `_drafts/<topic-folder>/`. Mirrors
the target structure (clearest "this draft is going where" signal),
keeps drafts as real markdown the user can edit in Obsidian, gives
retrieval an easy folder-prefix filter to exclude. (c) puts drafts
outside the editor which fights Obsidian's UX; (d) puts the
filtering burden on every reader.>`

---

### D2 — Citation enforcement

When the generative engine produces a draft, what's the citation
contract?

**(a) Block-level: every paragraph carries an inline citation
suffix.** Example: `The Q3 plan was revised in late August
[[2025-08-21-leadership-sync#decisions]].` **Pro:** finest granularity,
matches how retrieval grounds. **Con:** noisy in the rendered note.

**(b) Footnote-style at end of paragraph.** Markdown footnotes
(`[^1]: [[source]]`). **Pro:** clean reading. **Con:** writing
footnotes-by-LLM is fragile.

**(c) Citations block at end of the draft.** Every chunk that
informed the draft is listed once. **Pro:** simplest. **Con:** loses
the paragraph-to-source mapping.

**(d) Hybrid: inline citations during drafting (visible to the
LLM in the markdown), collapsed to footnotes for the rendered
view.** Plugin-side transform.

**(e) Citations as YAML frontmatter array.** Hidden by default.
Surfaced in a citations panel on the draft card.

`<DECISION D2: PROPOSED — (a) + (e) combined. Inline `[[source]]`
markers during drafting (so the LLM and the user both see the
provenance trail in-line), plus a frontmatter `cited_chunks: [...]`
array that the promotion path uses to verify "every cited chunk is
still in the index" before commit. Footnote rendering is a v1.3
polish — it's pure presentation.>`

---

### D3 — Uncited content policy

What happens when the LLM wants to write something *not* grounded in
a retrieved chunk (synthesis, transition prose, framing)?

**(a) Refuse — every sentence must cite.** Most conservative.
**Con:** drafts read robotic.

**(b) Allow uncited prose but mark it with `<!-- uncited -->`
comments.** Visible to the user, retrievable by tooling.

**(c) Allow uncited prose freely; the citations array tracks only
grounded claims.** Trust the user to review.

**(d) Configurable: `citationPolicy: 'strict' | 'marked' | 'free'`.**
Default `'marked'`.

`<DECISION D3: PROPOSED — (d) with default `'marked'`. Strict refusal
makes for bad first drafts; free trust makes for unreviewable drafts.
`'marked'` is the readable middle — uncited transition sentences are
visible as comments so the user can decide whether to keep them or
ask Claude to ground them on promotion.>`

---

### D4 — Drafting model

Drafting is harder than chat. It needs longer context, more careful
generation, and less hallucination.

**(a) Same as `defaultModel`.** Simplest, reuses budget.

**(b) Separate setting `draftingModel`, default Opus 4.7.**
Best-quality default for the highest-stakes operation; user can
downgrade.

**(c) Opus 4.7 default, but Sonnet 4.6 for iteration / refinement
calls.** Quality where it matters, speed where it doesn't.

`<DECISION D4: PROPOSED — (b). Drafting is the one place where the
quality/cost trade-off bends toward quality. Opus 4.7 default;
user can pick Sonnet if budget pressure dominates. Budget tracking
(spec §3.4) already separates `maxDollarsPerDay` so users see drafting
cost clearly.>`

---

### D5 — Drafting UI surface

Where does the user invoke drafting?

**(a) New side panel "Drafts" (companion to Suggestions + Activity).**
Lists in-flight drafts, lets user open one for iteration, promote, or
discard. Drafting starts from a `Sagittarius: New draft` command
that opens a topic-input modal.

**(b) Inline in ChatView with a "Draft" mode toggle.** Same panel,
different tab. Drafts get a `[Draft mode]` indicator in the chat.

**(c) Modal-driven session.** User invokes "New draft" → modal →
iterate via chat-in-modal → close on promote/discard.

**(d) Both (a) and (b).** Side panel for management, ChatView
mode for iteration.

`<DECISION D5: PROPOSED — (d). Drafts side panel is the canonical
"what drafts exist" surface (mirrors Suggestions + Activity per
ADR-019). ChatView "Draft" mode is the work surface — turning chat
into iterative refinement of a specific draft note. (c) modals are
too constrained for the iterative-refinement use case.>`

---

### D6 — Iteration model

A draft rarely lands right the first time. How does the user refine?

**(a) Free chat in the Draft mode.** User says "tighten paragraph 2,
add a citation to last week's standup note"; Claude returns a new
full draft. Replace-in-place.

**(b) `patch_note`-style edits on the draft file.** Claude proposes
per-section edits via the existing diff card.

**(c) Hybrid: chat for high-level direction, `patch_note` for
specific edits.** Same chat surface; tool routing decides.

`<DECISION D6: PROPOSED — (c). The chat surface is the same as
in-app chat; what's different is the model knows "you're refining
the draft at path X" and routes its tool calls accordingly. Whole-
draft replacements use `patch_note` with a single op spanning the
entire body; targeted edits use scoped ops. The diff card per
proposal preserves ADR-016 D2's invariant.>`

---

### D7 — Promotion path

How does a draft escape `_drafts/` and become canonical?

**(a) `Promote draft` command → `move_note` from `_drafts/X` to
`X` via the diff card.** Simple. Reuses Phase 4's `move_note`.

**(b) Promote → `create_note` at the canonical path + `delete_note`
on the draft (two diff cards, sequential).** Matches the v1.0.7
duplicate-merge combo pattern.

**(c) Promote → atomic "rename out of drafts" with a new
`_drafts_lift` tool.** New tool, single diff card. Cleaner UX,
more code.

**(d) Inline: editing the draft and removing `quarantined: true`
frontmatter promotes.** Goes with D1 (d). Lighter.

`<DECISION D7: PROPOSED — (a). `move_note` already exists, handles
wikilink rewrites, has a diff card. The draft path
(`_drafts/10-Inbox/foo.md` → `10-Inbox/foo.md`) is a simple rename.
(b) reuses the v1.0.7 pattern but doubles the diff cards needlessly
when nothing's being merged. (c) is over-engineering. (d) only
makes sense with D1 (d) which we rejected.>`

---

### D8 — Proactive draft suggestions

Spec §10 hints at "curator-style proactive prompts" — Claude offering
to draft something the user hasn't asked for.

**(a) Defer to v1.3.** Phase 8 ships user-initiated drafts only.

**(b) Add a `DraftSuggestionRule` to the curator orchestrator** —
a 7th curator rule that detects "you have N notes about X but no
synthesis" and proposes a draft. Reuses the suggestion queue +
diff card; user can Accept (draft is created in `_drafts/`),
Skip, or Defer.

**(c) Same as (b), but explicit user opt-in per topic (the user
configures "watch for synthesis gaps in `30-Projects/`").**

`<DECISION D8: PROPOSED — (a) defer to v1.3. Phase 8 has enough
substrate work — quarantine, citation contract, drafting UI,
promotion path — without also building the proactive-suggestion
half. ADR-022 lesson 2 ("pure-rule first, LLM-judged second") says
the curator equivalent of generative work is "detect gap" — that
needs its own ADR once Phase 8's reactive surface is shaken out.>`

---

### D9 — Relationship to the existing diff card

The diff card was built for *modifications* to existing notes
(ADR-016 D2). Generative output is *new* notes that didn't exist
before. Are they the same workflow?

**(a) Reuse `create_note` proposal + `'create-file'` diff card.**
A draft is just a `create_note` with the file going to `_drafts/`.
Promotion is `move_note`. **Pro:** zero new diff-card variants.
**Con:** the citation provenance + draft metadata isn't surfaced
in the existing `create-file` card.

**(b) New `'draft-note'` ProposalDiff variant** that renders the
draft body + citations panel + promote-vs-edit-vs-discard buttons.
**Pro:** purpose-built UX. **Con:** new code path; the diff card
becomes a two-mode surface.

**(c) Drafts bypass the diff card entirely** — they write directly
into `_drafts/` and the user reviews in the Drafts side panel.
**Pro:** simplest. **Con:** breaks ADR-016 D2.

`<DECISION D9: PROPOSED — (a). A draft is `create_note(path =
_drafts/<topic>/<slug>.md, content = <body with inline cites>)`.
Existing diff card handles it. The Drafts side panel
(D5 (d)) is the post-creation management surface. Promotion is
a separate `move_note` proposal. (b) is the right answer eventually
but Phase 8 should land with the minimum new diff-card surface
(per Phase 6 lesson "emitter-seam sprawl" / ADR-020).>`

---

### D10 — Phase 8 scope boundary + version

Phase 8 spans a lot. Where does v1.2.0 stop?

**(a) Minimal:** user-initiated drafts, `_drafts/` storage, inline
citations, basic promotion via `move_note`. No proactive
suggestions, no footnote rendering, no draft-iteration mode.
**Versions:** v1.2.0.

**(b) Plus iteration:** D6 (c) refinement loop, draft-mode in
ChatView, multi-turn drafting. **Versions:** v1.2.0 (MVP) →
v1.2.x (iteration polish).

**(c) Plus proactive:** D8 (b) curator integration too. Closer to
spec §10's full vision. **Versions:** v1.2.0 → v1.3.0.

**(d) Plus memory:** fold Phase 9 (CLAUDE.md reader/writer,
dossiers) into the same minor bump. Larger but ships the
"agent that remembers + writes" story together.

`<DECISION D10: PROPOSED — (b). MVP = user-initiated draft +
quarantine + citations + promotion, shipped as v1.2.0. Iteration
polish = v1.2.x patches. Proactive draft suggestions (D8 (b)) is
v1.3.0; memory layer (Phase 9) is its own ADR. Keep this phase's
scope tight per ADR-018 lesson 2 ("phases close on time when scope
is held."). v1.2.0 minor bump signals "Sagittarius now writes
proactively-on-request" — a meaningful behavior change.>`

---

## Open questions (no proposed decision)

**OQ1 — Citation drift across promotion.** A draft cites
`[[2025-08-21-leadership-sync#decisions]]`. By the time the user
promotes, that note has been edited and the `decisions` header
is gone. Do we:
  - Block promotion until citations resolve?
  - Promote with a warning Notice?
  - Auto-rewrite cited chunk IDs to current line ranges (impossible
    without semantic match)?

**OQ2 — External sources.** Spec §10 says "cited drafts" without
specifying source domain. Are external URLs (web pages, papers)
first-class citations alongside vault wikilinks? If so, what's the
quarantine seam for fetched external content (Phase 6.7's MCP
write-side has the same question)?

**OQ3 — Token budget for drafting.** Drafting can run 5-10k output
tokens easily. Phase 8 needs a dedicated budget bucket or accepts
that one draft can blow the daily budget. Per-draft hard cap?

Surface for Thad's input.

---

## Related

- [02_SPEC.md §10](02_SPEC.md) — Phase 8 spec; this ADR plans
  against it.
- [ADR-024](2026-05-14-phase-7-close.md) — Phase 7 close; lesson 1
  on bundling LLM-judged code with its production judge applies
  to drafting (the citation enforcer is the moral equivalent of
  a judge — ship them together).
- [ADR-022](2026-05-13-adr-022-phase-7-curator-plan.md) — Phase 7
  plan; D7 trust-calibration loop (SkipPatternStore) suggests the
  Drafts side panel needs a similar "remember I rejected this kind
  of draft" mechanism. Earmark for v1.2.x.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — Phase 4 plan;
  D2 ("every write through the diff card") is the invariant D9
  preserves.
- [ADR-018](2026-05-12-phase-5-close.md) — Phase 5 close; lesson 2
  on scope-holding applies to D10's cut line.
- [ADR-020](2026-05-13-phase-6-close.md) — Phase 6 close; lesson 1
  on emitter-seam sprawl informs D9 (a)'s "minimum new diff-card
  surface" reasoning.

## Sign-off

Awaiting Thad. Decisions D1-D10 + OQ1-OQ3 each need explicit accept
/ amend / reject before code lands.
