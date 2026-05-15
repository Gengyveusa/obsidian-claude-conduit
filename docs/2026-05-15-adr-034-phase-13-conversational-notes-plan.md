---
title: "ADR-034: Phase 13 plan — Conversational notes (v1.6.0)"
type: decision
status: "Proposed (D1-D10 await batch acceptance)"
date: 2026-05-15
---

## Context

Phase 12 (just shipped at v1.5.0) made memory mutual: agent writes
journals, future cascades read them. Phase 13 inverts a different
arrow per ADR-031: **chat history becomes durable vault content.**
Today, conversations are logged to a JSON file (`ConversationLogger`
from Phase 3) — searchable through the index but stored as
opaque-to-operator structured data. After Phase 13, every saved
conversation is a regular markdown note in the operator's vault:
retrievable, linkable, editable, indexable like any other note.

The contrast with Phase 12 matters:

| | Phase 12 (journal) | Phase 13 (conversational notes) |
|---|---|---|
| **Content** | Agent's summary (4 bullets) | Full transcript (every turn) |
| **Consumer** | Future agent (cascade) | Future operator (search/retrieval) |
| **Purpose** | Meta about the session | The session itself, durable |
| **Format** | Bounded ~400 tokens | Unbounded (whatever was said) |

Both ride the same surface (operator-triggered, session-end, diff
card per ADR-016 D2, written via existing `create_note`). Phase 13
reuses the substrate Phase 12 just established — same ChatView
hook, same write path, same opt-in posture.

This ADR is the Phase 13 plan. Same template as ADR-026/029/032/033:
10 decisions, batch-accept, same-session implementation.

## Goals

- **Conversations become first-class vault content** — searchable via
  the index, linkable from other notes, editable like anything else
- **One markdown file per saved conversation** — clean granularity,
  no fragmentation, no mega-files
- **Reuse Phase 12's substrate** — same trigger pattern, same write
  surface, same opt-in posture (consistency = trust)
- **Zero new write tools** (compose existing primitives per ADR-028
  lesson 2)

## Decisions

### D1. Path: `_chats/<YYYY-MM-DD>/<slug>.md`, one file per session.

**Selected:** chat notes live at e.g.
`_chats/2026-05-15/q3-roadmap-synthesis.md`. Date subfolder keeps
the directory bounded; slug from the first user message keeps each
file recognizable.

**Why subfolder by date** (vs flat `_chats/<date>-<slug>.md`):
operators with heavy chat use will accumulate fast (10+ chats/day
for a power user). Subfolder bounding prevents file-explorer
overload. Mirrors the `_drafts/` quarantine pattern: prefix-marked,
operator-visible, organization-engine-ignored.

**One file per session.** Per-turn fragmentation creates noise +
breaks search-coherence (you want the WHOLE conversation, not turn
17 of 23). Long conversations stay in one file; markdown handles
length fine.

### D2. Granularity: per-session, written at session save time.

**Selected:** the file is created when the operator runs
`Sagittarius: Save this conversation as a note`. No per-turn
auto-write. ChatView's in-memory history (already exposed via
`ChatView.recentHistory()` from Phase 12) IS the source.

**Why operator-triggered:** echoes Phase 12 D2 (operator-triggered
MVP, auto-trigger as v1.X.x follow-up). The "what counts as a
session ending" question hasn't been answered yet; ship the manual
command first; learn from real use.

**Follow-up slot:** v1.6.1 — `chatNotesAutoSave` setting
(`manual` | `on-session-end` | `idle-30m`).

### D3. Frontmatter shape — full session metadata.

**Selected:** every chat note carries:

```yaml
---
type: chat
session_id: 'a8f3-2026-05-15T22:14'   # uuid-ish; derived from start time
started_at: 1747350840
ended_at: 1747352140
mode: 'chat'                           # or 'vault-qa' / 'draft-refine'
tokens_in: 4231
tokens_out: 1872
cost_usd: 0.029
turn_count: 8
cited_chunks:
  - { note: '30-Projects/q3.md', chunk: 0, score: 0.91 }
  - { note: '50-FortressFlow/Pipeline_State.md', chunk: 2, score: 0.83 }
---
```

`type: chat` makes the note distinguishable from drafts (`type:
chat` vs drafting's `cited_chunks` only — no `type` field in
drafts). Curator + organization engine can ignore `type: chat`
notes if they want.

`cited_chunks` mirrors drafting's frontmatter shape so the
citation-drift verifier (v1.3.4) Just Works on chat notes too —
zero new code needed for "this conversation cited stale chunks."

### D4. Body format: Q&A blocks per turn.

**Selected:** each turn renders as:

```markdown
## Operator

<user message verbatim>

## Sagittarius

<assistant response, citations preserved as `[[]]` wikilinks>

---
```

H2 headers separate roles for visual + outline-rendering. Citations
already in the assistant's response stay as wikilinks — they
backlink to the cited notes automatically (Obsidian's metadata
cache handles this), so the chat note becomes a hub for the
conversation's source material.

**No tool-call blocks in the body** — those are noise. If the
agent ran `search_vault` or `read_note`, the result lands in the
text it produced; the tool call itself isn't rendered. Operators
who want the full tool trace can read the JSON
`conversation.log.jsonl` (Phase 3 logger, unchanged).

### D5. Reuse `ChatView.recentHistory()` + new `ChatNoteWriter`.

**Selected:** Phase 12 already added `ChatView.recentHistory()`.
Phase 13 reuses it for the source. New `src/chats/ChatNoteWriter.ts`
takes the history + frontmatter metadata + last-turn TurnResult
(for tokens/cost) and produces the `{path, content}` pair the
plugin layer wraps in a `create_note` proposal.

`ChatNoteWriter` is pure (no I/O); rendering logic lives there;
plugin layer handles the file write through the diff card. Same
pattern as `AnthropicJournalGenerator` minus the LLM call (no
generation needed — the conversation IS the content).

### D6. Trigger UI — command + ChatView button.

**Selected:** two surfaces for the same action:

1. **Command palette:** `Sagittarius: Save this conversation as a note`
2. **ChatView header button:** "📝 Save as note" next to the
   mode dropdown — visible affordance during the conversation

Both call the same plugin handler. ChatView button preempts the
"how do I save this?" question without making operators learn the
command palette.

### D7. Privacy default — opt-in (OFF until enabled), per-conversation opt-out always available.

**Selected:** `chatNotesEnabled: false` in `DEFAULT_SETTINGS`
(matches Phase 12's `journalEnabled` posture). The command + button
exist but emit a Notice prompting enable on first use.

**Per-conversation opt-out:** even with the global enabled, each
conversation can be marked "don't save" via a ChatView toggle
(persists per-leaf, resets on new chat). Some conversations are
genuinely sensitive; opt-in-then-opt-out is the right granularity.

### D8. Diff card on every save — same as any other write.

**Selected:** the `create_note` proposal goes through the existing
diff card per ADR-016 D2. Operator sees the proposed file inline,
hits Accept (or Reject, or edits the body before accepting).

**Friction concern:** once-per-session, operator-initiated. Same
profile as Phase 12 journal; same conclusion: acceptable. If
operators end up saving 10+ conversations/day and the diff card
becomes annoying, v1.6.x can add an "auto-accept chat-note saves
from this session" toggle inside the diff card itself (echoing the
"approve all" curator pattern from Phase 7).

### D9. Zero new write tools — composes existing primitives.

**Selected:** chat-note saves use the existing `create_note` tool.
If a chat note with the same slug already exists for the same day
(rare — operator saved twice), the slug gets a `-2` suffix per
the existing `draftPathWithSuffix` helper logic (or copy that
pattern into a new `chatPathWithSuffix`).

Zero new write tools. Same discipline as Phase 9 D8, Phase 12 D9.

### D10. Ship plan — MVP at v1.6.0, named follow-ups as v1.6.x.

**Selected:**

**v1.6.0 MVP (next session):**
- `Sagittarius: Save this conversation as a note` command
- ChatView "Save as note" button in the header
- `ChatNoteWriter` (pure renderer; ~150 LOC)
- `_chats/<YYYY-MM-DD>/<slug>.md` path conventions (~50 LOC pure)
- Settings: `chatNotesEnabled` (default false) + `chatNotesDefaultSlug`
  (template, default first-30-chars-of-first-user-message)
- Per-conversation opt-out toggle on ChatView
- Tests: ~30 across renderer, path, command

**v1.6.x follow-ups (named slots per ADR-030 lesson 1):**
- **v1.6.1** — auto-save options (`chatNotesAutoSave: 'manual' |
  'on-session-end' | 'idle-30m'`)
- **v1.6.2** — chat notes side panel (read-only browser, like
  Phase 8's drafts panel)
- **v1.6.3** — "Replay this conversation" command (loads a chat
  note's history back into ChatView for continuation)
- **v1.6.4** — auto-link backlinks: if the conversation discussed
  note X, the chat note's `cited_chunks` already references X;
  add an inline `[[]]` link in the chat-note body so X's
  backlinks panel shows the chat note

**Phase 13 close ADR** after operator has saved ~10 conversations
across ~1 week. Lessons go in there.

## Risks / open questions

- **OQ1:** the `_chats/` folder will grow unbounded. v1.6.x retention
  policy (`chatNotesRetentionDays`?) might be needed but probably
  not — chat notes are USEFUL content, not journal-style ephemera.
  Defer to operator demand.
- **OQ2:** when the indexer rebuilds, chat notes get embedded
  alongside everything else. That means chat content shows up in
  retrieval results — including for `search_vault` calls that the
  agent itself makes. Recursive: a future agent might cite a past
  chat note. This is GOOD (future-self-as-source), but might want a
  setting to exclude `_chats/` from retrieval if it generates noise.
  Defer to v1.6.x.
- **OQ3:** sensitive conversations stored as plaintext markdown.
  Per the v1.3.1 README security note, plugin data + vault are not
  encrypted. Chat notes inherit the operator's existing vault
  security posture. Worth mentioning in the settings UI.

## Related

- [ADR-031](2026-05-15-adr-031-roadmap-phases-12-16.md) — roadmap;
  Phase 13 scope provisionally outlined; this ADR is the binding
  plan.
- [ADR-033](2026-05-15-adr-033-phase-12-reverse-memory-plan.md) —
  Phase 12 plan; the operator-triggered + diff-card + opt-in
  pattern this ADR mirrors. Phase 12's `ChatView.recentHistory()`
  is the data source D5 reuses.
- [ADR-026](2026-05-14-adr-026-phase-8-generative-layer-plan.md) —
  Phase 8 plan; D2 (e) `cited_chunks` frontmatter shape is the
  template D3 follows for chat-note frontmatter.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 (every write
  through the diff card) is the constraint D8 honors.
- [ADR-024](2026-05-14-phase-7-close.md) — lesson 1 (auto-anything
  earns trust slowly) is why D7 ships opt-in default.
- [ADR-028](2026-05-14-phase-8-close.md) — lesson 2 (compose
  existing primitives) is the architectural discipline D9
  preserves.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then same-session implementation.
