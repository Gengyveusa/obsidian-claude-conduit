# Sagittarius — Claude Conduit

Native Obsidian plugin for Claude. Chat with your vault, retrieval-grounded, every answer cites. Diff-first writes coming in v0.5.

> **Status:** v0.1.0 — Phase 3 read layer complete. Side panel, Cmd+P modal, settings tab, persistent SQLite index, transformers.js-powered local embeddings, 5 read tools (`read_note`, `list_folder`, `search_vault`, `get_backlinks`, `get_graph_neighborhood`), token + dollar budget caps, conversation logging to vault. **Pending live-vault smoke install before tagging.**

---

## Install (BRAT)

Sagittarius is not in the Obsidian community-plugin registry yet (planned for ~v0.3). Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins.
2. Open BRAT settings → **Add Beta Plugin** → enter `gengyveusa/obsidian-claude-conduit`.
3. Enable "Sagittarius — Claude Conduit" under Settings → Community Plugins.

Sagittarius is **desktop-only** (`isDesktopOnly: true` per ADR-007). It will not appear in the plugin list on iOS or Android. v1.1+ may relax this.

## Setup

1. Get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).
2. Settings → **Sagittarius — Claude Conduit** → paste the key into the *API key* field.
3. Pick your default + fallback model (Sonnet 4.6 is the recommended default; Opus 4.7 the fallback on overload).
4. Optionally adjust the daily token / dollar caps (defaults: 200K tokens / $10 / day, midnight reset in `America/Los_Angeles`).
5. The first time the plugin loads after API-key set, it will auto-index your vault in the background. First run downloads the `all-MiniLM-L6-v2` model (~22 MB, cached locally for subsequent runs). Watch the developer console for `auto-index: N notes, M chunks, …`.

### Security note

Your API key is stored in:

```
<vault>/.obsidian/plugins/obsidian-claude-conduit/data.json
```

The plugin's `.gitignore` excludes this path by default. If you keep `.obsidian/` under version control, **double-check that the plugin's `data.json` is excluded** before pasting your key. See spec §7 threat model.

No data leaves your machine without an API key set. Conversations write to your vault under `70-Memory/conversations/YYYY-MM-DD/{session-id}.md` (configurable in settings).

## Using

- **Side panel:** click the chat-bubble icon in the left ribbon, or Settings → "Open chat panel". Switch the mode dropdown between *Chat* (general) and *Vault QA* (every answer must cite a vault note).
- **Cmd+P quick question:** Cmd+P (or Ctrl+P) → "Sagittarius: Quick question". Single-shot Q&A in a modal — no scrollback.
- **Build / rebuild index:** Cmd+P → "Sagittarius: Build retrieval index (incremental)" or "Rebuild retrieval index from scratch". Auto-mode (the default) runs an incremental build on every plugin load.

## Smoke-test queries (per spec §1)

After install + API-key set + first auto-index completes:

1. **"Where does Phase 1 stand?"**
   *Expected:* Hangar-voice answer citing `[[50-FortressFlow/Pipeline_State]]`.
   *Verifies:* vault-qa mode + `search_vault` + Hangar voice loaded from `21-Agents/concierge.md`.

2. **"Pull up everything on Soltura"**
   *Expected:* ranked notes spanning `41-Soltura/` and `40-Quantum-Distillery/`.
   *Verifies:* multi-folder retrieval + cosine ranking.

3. **`schema_meta.writer == 'sagittarius'`**
   In a terminal, against `<vault>/.obsidian/plugins/obsidian-claude-conduit/index.sqlite`:
   ```bash
   sqlite3 <path> "SELECT value FROM schema_meta WHERE key='writer'"
   # → sagittarius
   ```
   *Verifies:* embedding contract §3 schema written correctly; confirms cross-engine readability of the file.

## Development

```bash
npm install
npm run dev          # esbuild watch
npm run build        # production main.js (~2 MB; sql.js wasm + onnxruntime-web inlined)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest run (149 tests)
```

To test inside Obsidian: copy `main.js` + `manifest.json` + `styles.css` into a vault's `.obsidian/plugins/obsidian-claude-conduit/` directory, enable in settings.

## Architecture

See [`docs/02_SPEC.md`](docs/02_SPEC.md) for the v0.1 spec, [`docs/05_CONDUIT_AGENT_SKETCH.md`](docs/05_CONDUIT_AGENT_SKETCH.md) for the agent class shape, and [`docs/embed_interface.md`](docs/embed_interface.md) for the embedding contract Sagittarius shares with `corpus-ingest`.

Key architectural decisions:
- [ADR-007](docs/2026-05-04-sagittarius-q1-q3-signoff.md) — direct `@anthropic-ai/sdk`, hybrid embeddings (local default), multi-vault aware, desktop-only v1.0.
- [ADR-010](docs/2026-05-04-sagittarius-build-process.md) — pair-via-claude-code build process.
- [ADR-011](docs/2026-05-06-sqlite-shipping-strategy.md) — `sql.js` (WASM) over `better-sqlite3` so distribution stays single-`main.js`.

## License

MIT — see [`LICENSE`](LICENSE).
