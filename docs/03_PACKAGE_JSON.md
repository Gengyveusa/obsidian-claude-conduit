---
title: "Sagittarius — package.json (intended)"
type: project
status: draft
created: 2026-05-04
updated: 2026-05-04
tags: [sagittarius, plugin, package-json, project, thad-man]
related:
  - "[[18-Obsidian-Claude-Plugin/02_SPEC]]"
  - "[[18-Obsidian-Claude-Plugin/04_MANIFEST_JSON]]"
last_reviewed: 2026-05-04
---

# Sagittarius — `package.json` (intended)

> Documents the `package.json` to be created in `gengyveusa/obsidian-claude-conduit` during Phase 2 (scaffold). Versions reflect cutoff state; bump when the new repo is initialized.

## File contents

```json
{
  "name": "obsidian-claude-conduit",
  "version": "0.1.0",
  "description": "Native Obsidian plugin for Claude — chat with your vault, retrieval-grounded, diff-first writes (coming v0.5).",
  "main": "main.js",
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs production",
    "dev": "node esbuild.config.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "lint": "eslint . --ext .ts",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "typecheck": "tsc --noEmit",
    "version-bump": "node scripts/version-bump.mjs",
    "release": "npm run build && npm run test && npm run version-bump"
  },
  "keywords": [
    "obsidian-md",
    "obsidian-plugin",
    "claude",
    "anthropic",
    "ai",
    "llm",
    "knowledge-management",
    "rag",
    "embeddings"
  ],
  "author": "GengyveUSA",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/gengyveusa/obsidian-claude-conduit.git"
  },
  "bugs": {
    "url": "https://github.com/gengyveusa/obsidian-claude-conduit/issues"
  },
  "homepage": "https://github.com/gengyveusa/obsidian-claude-conduit#readme",
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.0",
    "@xenova/transformers": "^2.17.2",
    "better-sqlite3": "^11.5.0",
    "yaml": "^2.6.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.10.0",
    "@typescript-eslint/eslint-plugin": "^8.15.0",
    "@typescript-eslint/parser": "^8.15.0",
    "builtin-modules": "^4.0.0",
    "esbuild": "^0.24.0",
    "eslint": "^9.15.0",
    "obsidian": "^1.7.2",
    "prettier": "^3.4.0",
    "tslib": "^2.8.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

## Dependency rationale (why each)

| Dep | Why |
|---|---|
| `@anthropic-ai/sdk` | The canonical Claude SDK. Per [[20-Decisions/2026-05-04-sagittarius-q1-q3-signoff\|ADR-007 Q1]] = (a) Direct SDK primary. |
| `@xenova/transformers` | Provides `all-MiniLM-L6-v2` via ONNX-WASM in the browser/Node. Required to honor the [[Assets/code/corpus-ingest/parsers/embed_interface\|embedding contract]]'s "same model as corpus-ingest." Bundle cost ~3MB; model file ~22MB downloaded on first index. |
| `better-sqlite3` | Native SQLite for Node. Sagittarius is desktop-only (per ADR-007 bonus); `better-sqlite3` is faster than `sql.js` and avoids WASM overhead. Mobile would force sql.js — defer. |
| `yaml` | Frontmatter parsing. Standard. |
| `zod` | Tool input/output schema validation at the agent's tool-call boundary. Each tool's input_schema gets a paired Zod schema for runtime validation. |

### Dev dependency rationale

| Dep | Why |
|---|---|
| `obsidian` | Plugin API types. `peerDependency`-style; not bundled. |
| `esbuild` | The canonical Obsidian plugin build tool. Single `main.js` bundle. |
| `vitest` | Per killer prompt §4 — "vitest for units, playwright for the Obsidian test harness." Phase 1 focuses on vitest; playwright in Phase 2. |
| `eslint` + `@typescript-eslint/*` | Strict TS lint (per killer prompt §9 — "no `any` except at FFI boundaries with a `// TODO: type` note"). |
| `prettier` | Format consistency. Configure with single-quotes, trailing commas, 100 char line width to match contemporary TS style. |
| `tslib` | Required for `importHelpers: true` in tsconfig (smaller bundle). |
| `typescript` | Compiler. Strict mode required by killer prompt §4. |
| `builtin-modules` | Esbuild needs to know which modules are Node builtins to externalize. |

## Versions to revisit at Phase 2 kickoff

The version pins above are "current at cutoff." When Thad creates the repo, run `npm install --save-exact` to lock to the latest at that moment. Pin exact versions (no `^` prefix) per [[20-Decisions/2026-05-04-sagittarius-build-process\|ADR-010]]'s "no telemetry default" stance — supply-chain hygiene.

## Scripts rationale

- `build` — production build (minified, single `main.js` + `styles.css` per Obsidian convention).
- `dev` — watch mode build for fast iteration.
- `test` — unit tests via vitest.
- `test:integration` — integration tests against a fixture vault under `test/fixtures/vault/` per killer prompt §4.
- `lint`, `format`, `typecheck` — quality gates per killer prompt §9.
- `version-bump` — Obsidian plugins require coordinated bumps in `manifest.json` + `versions.json` + `package.json`. Single script handles all three.
- `release` — meta-script: build + test + version-bump. Manual `git push --tags` + GitHub release follow.

## What this file is NOT

- Not the source of truth — once `gengyveusa/obsidian-claude-conduit/package.json` is created, that file is canonical. This vault file is **the design intent**.
- Not version-locked — version pins here are guidance; Phase 2 kickoff will install latest and lock-exact at that moment.

## Related

- [[18-Obsidian-Claude-Plugin/02_SPEC]] — the spec these dependencies serve
- [[18-Obsidian-Claude-Plugin/04_MANIFEST_JSON]] — Obsidian manifest (paired)
- [[20-Decisions/2026-05-04-sagittarius-build-process]] — ADR-010 (Phase 2 scaffold)
- [[20-Decisions/2026-05-04-sagittarius-q1-q3-signoff]] — ADR-007 (architecture)
