# Sagittarius — Claude Conduit

Native Obsidian plugin for Claude. Chat with your vault, retrieval-grounded, every answer cites. Diff-first writes coming v0.5.

> **Status:** v0.1.0 — Phase 2 scaffold. The plugin loads in Obsidian and registers a ribbon icon. Side panel, retrieval, tool use, and budget tracking land in Phase 3 per [`docs/02_SPEC.md`](docs/02_SPEC.md).

---

## Install (BRAT)

Sagittarius is not in the Obsidian community-plugin registry yet (planned for ~v0.3). Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community Plugins.
2. Open BRAT settings → **Add Beta Plugin** → enter `gengyveusa/obsidian-claude-conduit`.
3. Enable "Sagittarius — Claude Conduit" under Settings → Community Plugins.

Sagittarius is **desktop-only** (`isDesktopOnly: true` per ADR-007). It will not appear in the plugin list on iOS or Android.

## Setup

1. Get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).
2. (Settings tab lands in Phase 3.) For now, the plugin scaffold has no runtime configuration.

### Security note

When the settings tab lands, your API key will be stored in this plugin's data directory at:

```
<vault>/.obsidian/plugins/obsidian-claude-conduit/data.json
```

That path is gitignored by default in this repo. If you keep your `.obsidian/` directory under version control in your own vault, **make sure the plugin's `data.json` is excluded** before pasting an API key. See spec §7 threat model.

## Smoke tests (planned for v0.1 acceptance)

Per [`docs/02_SPEC.md`](docs/02_SPEC.md) §1:

1. *"Where does Phase 1 stand?"* → Hangar-voice answer citing `[[50-FortressFlow/Pipeline_State]]`.
2. *"Pull up everything on Soltura"* → ranked notes across `41-Soltura/`, `40-Quantum-Distillery/`.
3. Verifiable retrieval via `schema_meta.writer == 'sagittarius'` in the SQLite index.

## Development

```bash
npm install
npm run dev          # esbuild watch
npm run build        # production main.js
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest
```

To test inside Obsidian, symlink (or copy) `main.js`, `manifest.json`, and `styles.css` into a vault's `.obsidian/plugins/obsidian-claude-conduit/` directory.

## Architecture

See [`docs/02_SPEC.md`](docs/02_SPEC.md) for the v0.1 spec, [`docs/05_CONDUIT_AGENT_SKETCH.md`](docs/05_CONDUIT_AGENT_SKETCH.md) for the agent class shape, and [`docs/embed_interface.md`](docs/embed_interface.md) for the embedding contract Sagittarius shares with `corpus-ingest`.

## License

MIT — see [`LICENSE`](LICENSE).
