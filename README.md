# Sagittarius — Claude Conduit

Native Obsidian plugin for Claude. Chat with your vault, draft cited notes, and let Claude propose edits — but every byte hits disk only after a diff card you reviewed. Your vault stays yours.

> **v1.3.0** — chat + retrieval, diff-first writes, auto-organization, curator, MCP bridge to Claude Desktop, generative drafting with quarantine, and a CLAUDE.md memory cascade. 1027 tests. Desktop-only.

![Sagittarius chat panel screenshot — placeholder](docs/screenshots/chat-panel.png)

## What it does

- **Chat with your vault, grounded in your own notes.** Semantic retrieval cites the chunks it used. Two modes: **Chat** (cite when relevant) and **Vault QA** (must cite).
- **Edit your vault — but only through a diff card.** Claude proposes; you review the unified diff; you accept or reject. Every write is reversible via the transaction log.
- **Draft cited markdown notes** on any topic. Drafts land in `_drafts/` quarantine with `[[note-path]]` inline citations + `cited_chunks: [...]` frontmatter. Promote with one command.
- **Memory via `CLAUDE.md`.** Drop a `CLAUDE.md` at the vault root or inside any folder; Sagittarius loads the matching cascade into the system prompt every chat turn.
- **MCP bridge.** Use Claude Desktop (or any MCP client) to read your vault from outside Obsidian. Write proposals queue inside Obsidian for your approval, with OS notifications.
- **Auto-organize the inbox.** Auto-route new notes to the right folder; auto-maintain MOC links.
- **Curator.** A scheduled hygiene pass surfaces broken links, orphans, stale notes, schema violations, duplicate candidates, and tag-casing drift.
- **Activity stream.** Every event (chat turn, write, suggestion, MCP call) lands in a side panel for review.
- **Daily budget caps.** Token + dollar limits with auto-rollover at midnight in your local timezone.

See the [phase map](#phase-map) below for what shipped when.

---

## Install

### Via BRAT (recommended for now)

Sagittarius is not yet in the Obsidian community plugin registry (planned for after v1.3.x lives in the wild for a bit). Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Settings → Community Plugins.
2. Open BRAT settings → **Add Beta Plugin** → enter `gengyveusa/obsidian-claude-conduit`.
3. Enable "Sagittarius — Claude Conduit" under Settings → Community Plugins.

Sagittarius is **desktop-only** (`isDesktopOnly: true` per ADR-007); it will not appear on iOS or Android.

### Manual install

Drop `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/gengyveusa/obsidian-claude-conduit/releases) into `<your-vault>/.obsidian/plugins/obsidian-claude-conduit/`, then enable in settings.

---

## Setup

1. **Anthropic API key** — get one at [console.anthropic.com](https://console.anthropic.com). Settings → **Sagittarius — Claude Conduit** → paste into *Anthropic API key*.
2. **HuggingFace API key** *(optional but strongly recommended)* — required for semantic search and Vault QA mode. Free read-token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). Without it, Sagittarius works in chat-mode only with the 4 non-search vault tools.
3. **Pick your default + fallback model.** Sonnet 4.6 is the recommended default; Opus 4.7 is the fallback on overload. Drafting defaults to Opus 4.7.
4. **Set daily caps.** Defaults: 200K tokens / $10 / day, midnight reset in `America/Los_Angeles`. Adjust to taste.
5. **Build the index** when ready: `Cmd+P` → *Sagittarius: Build retrieval index (incremental)*. First build over a typical vault takes ~30s of HF API time; later edits incrementally rebuild. Default `indexingMode` is `manual` per ADR-013 — no surprise network traffic.

### Security note

Your API keys are stored in Obsidian's plugin data file (`<vault>/.obsidian/plugins/obsidian-claude-conduit/data.json`), unencrypted. This matches Obsidian's standard storage for plugin secrets. If your vault is in iCloud / Dropbox / sync, your keys travel with it. Consider a separate vault for sensitive work.

---

## Daily commands

All accessible via Cmd+P (no default hotkeys — bind your own in Settings → Hotkeys):

| Command | What it does |
|---|---|
| **Open chat panel** | Side-panel chat with your vault |
| **Quick question** | Cmd+P modal for one-shot questions, no history |
| **New draft** | Open the topic modal; engine drafts a cited markdown note |
| **Promote draft** | Move the open `_drafts/` note to its canonical location |
| **Open drafts panel** | Side panel listing every file under `_drafts/` |
| **Open suggestions panel** | Curator + organization-engine proposals |
| **Open activity stream** | Event log with filtering |
| **Open external proposals panel** | Writes pending from Claude Desktop / MCP clients |
| **Run curator** | Scheduled hygiene pass on demand |
| **Organize inbox now** | Auto-route inbox notes |
| **Build / Rebuild retrieval index** | Index your vault for semantic search |
| **Undo last write transaction** | Reverse the most recent diff-card write |
| **System check** | Live-stack health: API key, index, MCP server, retrieval status |
| **Test MCP connection** | Verify the MCP server is reachable from Claude Desktop |
| **Run diagnostics** | Detailed plugin state report |

---

## Memory cascade

Drop `CLAUDE.md` at any folder level. Sagittarius loads the cascade for the currently-active file:

```
your-vault/
├── CLAUDE.md                              ← always loads
├── 30-Projects/
│   ├── CLAUDE.md                          ← loads when in 30-Projects/
│   └── sagittarius/
│       ├── CLAUDE.md                      ← loads when in sagittarius/
│       └── notes/
│           └── 2026-05-14.md              ← active file
```

For the file above, all four `CLAUDE.md`s load (root → most-specific). Status bar pill shows the live cascade size; click for the preview modal. Default budget is 50KB; soft-truncates at the cap.

To update memory, ask Sagittarius. It proposes via `append_to_note` / `patch_note` like any other vault edit — diff card gates the write.

---

## MCP bridge (Claude Desktop integration)

When MCP is enabled in settings, Sagittarius runs an MCP server that Claude Desktop can connect to:

1. **Settings → MCP bridge** → enable. Note the URL + token.
2. In Claude Desktop's `claude_desktop_config.json`, add Sagittarius as an MCP server (HTTP transport with the token).
3. Claude Desktop now sees your vault. **5 read tools always exposed.** Toggle "Allow MCP write tools" to expose 9 write tools (still gated by the diff card on the Obsidian side); toggle "Allow MCP delete" for `delete_note`.

Write proposals from outside Obsidian queue in the **External proposals** side panel and fire an OS notification. Click the notification to focus Obsidian and approve.

---

## Drafting workflow

```
Sagittarius: New draft
  → topic modal (e.g. "Q3 roadmap synthesis from leadership-sync notes")
  → engine retrieves K chunks
  → drafts markdown with [[]] citations + cited_chunks frontmatter
  → diff card opens in chat panel
  → accept → file lands at _drafts/<destination>/<slug>.md
```

The draft is quarantined under `_drafts/`. Browse, refine, or discard via the **Drafts panel**. When ready: open the draft, run **Sagittarius: Promote draft** — it routes through `move_note` to strip the `_drafts/` prefix.

Three citation policies (Settings → Generative drafting):
- **strict** — every paragraph must cite; engine retries once on violation
- **marked** *(default)* — synthesis prose wrapped in `<!-- uncited -->...<!-- /uncited -->` HTML comments
- **free** — uncited prose passes through unannotated

---

## Phase map

| Phase | Output | Status |
|---|---|---|
| 1 — Spec | `docs/02_SPEC.md`, ADRs | done |
| 2 — Scaffold | esbuild, manifest, plugin entry | done |
| 3 — Read layer | side panel, retrieval, 5 read tools, budget | done (v0.2.5) |
| 4 — Write layer | diff-first writes, transaction log, undo | done (v0.5.0) |
| 5 — Organization engine | auto-routing, MOC maintenance | done (v0.7.0) |
| 6 — Activity stream | events log, diagnostics, digest | done (v0.8.2) |
| 6.5 — MCP bridge (read) | Sagittarius tools over Model Context Protocol | done (v0.9.2) |
| 7 — Curator | proactive vault hygiene | done (v1.0.3) |
| 6.7 — MCP write-side | gated write tools, queue, OS notifications | done (v1.1.0) |
| 8 — Generative layer | cited drafts, drafts panel, promotion | done (v1.2.0) |
| 9 — Memory layer | `CLAUDE.md` cascade | MVP (v1.3.0); close TBD |
| 10 — Polish | README, screenshots, command grooming | in progress |
| 11 — Release | tag, BRAT-list, community-registry submission | future |

---

## Try it

After install + setup:

1. **"What's in my Inbox today?"** — verifies retrieval against your vault
2. Switch to **Vault QA** mode → ask anything where citations matter
3. **Sagittarius: New draft** → "summarize the last quarter from my standup notes" — first cited draft
4. Drop a `CLAUDE.md` at vault root → "remember that snake_case is house style" → next chat reflects it
5. **Sagittarius: Run curator** → see what hygiene work the bot would propose

---

## Development

```bash
npm install
npm run dev          # esbuild watch
npm run build        # production main.js (~2 MB; sql.js wasm + onnxruntime-web inlined)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest run (1027 tests)
```

To test inside Obsidian: copy `main.js` + `manifest.json` + `styles.css` into a vault's `.obsidian/plugins/obsidian-claude-conduit/` directory, enable in settings.

---

## Architecture

The agent's full design lives in [`docs/02_SPEC.md`](docs/02_SPEC.md). The class shape is sketched in [`docs/05_CONDUIT_AGENT_SKETCH.md`](docs/05_CONDUIT_AGENT_SKETCH.md). The embedding contract Sagittarius shares with `corpus-ingest` is in [`docs/embed_interface.md`](docs/embed_interface.md).

Key architectural decisions (every phase has a plan ADR + a close ADR):

- [ADR-007](docs/2026-05-04-sagittarius-q1-q3-signoff.md) — direct `@anthropic-ai/sdk`, hybrid embeddings, multi-vault aware, desktop-only v1.0.
- [ADR-010](docs/2026-05-04-sagittarius-build-process.md) — `pair-via-claude-code` build process. Thad decides; Claude implements.
- [ADR-011](docs/2026-05-06-sqlite-shipping-strategy.md) — `sql.js` (WASM) over `better-sqlite3` so distribution stays single-file.
- [ADR-016](docs/2026-05-10-adr-016-phase-4-plan.md) — Phase 4 write-layer plan; **D2 (every write through the diff card)** is the load-bearing constraint that makes every later phase's primitive-reuse possible.
- [ADR-026](docs/2026-05-14-adr-026-phase-8-generative-layer-plan.md) — Phase 8 generative drafting plan.
- [ADR-029](docs/2026-05-14-adr-029-phase-9-memory-plan.md) — Phase 9 `CLAUDE.md` cascade plan.

Browse the full ADR set under [`docs/`](docs/). The build process (ADR-010) means every phase has a plan-ADR before code and a close-ADR after, with two retrospective lessons each.

---

## Support

If Sagittarius earns its keep in your workflow, [GitHub Sponsors](https://github.com/sponsors/gengyveusa) is the way to say thanks. Plugin development is volunteered; Anthropic API costs are still on you.

## License

MIT — see [`LICENSE`](LICENSE).
