# Sagittarius — Claude Conduit

Native Obsidian plugin for Claude. Chat with your vault, retrieval-grounded, every answer cites. Diff-first writes coming in v0.5.

> **Status:** v0.2.1 — chat-mode + 5 vault tools (`read_note`, `list_folder`, `search_vault`, `get_backlinks`, `get_graph_neighborhood`). Side panel, Cmd+P modal, settings tab, conversation logging to vault, daily token + dollar budget caps, model fallback. **Semantic retrieval re-enabled via the HuggingFace Inference API per [ADR-013](docs/2026-05-08-hf-inference-embedding-strategy.md).** v0.1.x's transformers.js path is gone (didn't survive Obsidian's Electron renderer per ADR-012); v0.2 routes embeddings through `api-inference.huggingface.co` instead, via Obsidian's `requestUrl()` to dodge renderer CORS (v0.2.1 fix; see ADR-013 postscript). Without an HF token, the plugin gracefully degrades to v0.1.1 behavior (chat-mode + 4 tools).

---

## Install (BRAT)

Sagittarius is not in the Obsidian community-plugin registry yet (planned for ~v0.3). Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins.
2. Open BRAT settings → **Add Beta Plugin** → enter `gengyveusa/obsidian-claude-conduit`.
3. Enable "Sagittarius — Claude Conduit" under Settings → Community Plugins.

Sagittarius is **desktop-only** (`isDesktopOnly: true` per ADR-007). It will not appear in the plugin list on iOS or Android. v1.1+ may relax this.

## Setup

1. **Anthropic API key** — get one from [console.anthropic.com](https://console.anthropic.com). Required for chat. Settings → **Sagittarius — Claude Conduit** → paste it into the *API key* field.
2. **HuggingFace API key (optional)** — required only for semantic search / Vault QA mode. Free read-token from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens). Settings → Sagittarius → *HuggingFace API key*.
3. Pick your default + fallback model (Sonnet 4.6 is the recommended default; Opus 4.7 the fallback on overload).
4. Optionally adjust the daily token / dollar caps (defaults: 200K tokens / $10 / day, midnight reset in `America/Los_Angeles`).
5. **Build the index** when you're ready: `Cmd+P` → "Sagittarius: Build retrieval index (incremental)". First build over a typical vault takes ~30s of HF API time; subsequent edits incrementally rebuild. v0.2 default `indexingMode` is `'manual'` per ADR-013 — no surprise network traffic.

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

## Smoke-test queries

### Chat mode (works without HF token)

1. **"Summarize the file 50-FortressFlow/Pipeline_State.md"** — verifies `read_note` + system prompt loading.
2. **"What links to 70-Memory/people/harold-wallace.md?"** — verifies `get_backlinks` + metadata cache integration.
3. **"List the markdown files in 50-FortressFlow"** — verifies `list_folder`.

### Vault QA mode (v0.2, requires HF token + index built)

Switch the chat dropdown to **Vault QA**, then ask:

4. **"Where does Phase 1 stand?"** — verifies `search_vault` against your indexed vault. Should return a Hangar-voice answer citing `[[50-FortressFlow/Pipeline_State]]` without you naming the file.
5. **"Pull up everything on Soltura"** — verifies multi-folder retrieval. Should rank notes spanning `41-Soltura/` and `40-Quantum-Distillery/`.

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
