---
title: "Sagittarius — manifest.json (intended)"
type: project
status: draft
created: 2026-05-04
updated: 2026-05-04
tags: [sagittarius, plugin, manifest, obsidian, project, thad-man]
related:
  - "[[18-Obsidian-Claude-Plugin/02_SPEC]]"
  - "[[18-Obsidian-Claude-Plugin/03_PACKAGE_JSON]]"
last_reviewed: 2026-05-04
---

# Sagittarius — `manifest.json` (intended)

> The Obsidian plugin manifest. Required by Obsidian's plugin loader. Lives at the repo root in `gengyveusa/obsidian-claude-conduit`. Documents the intended content here as design.

## File contents

```json
{
  "id": "obsidian-claude-conduit",
  "name": "Sagittarius — Claude Conduit",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Native Obsidian plugin for Claude. Chat with your vault, retrieval-grounded, every answer cites. Diff-first writes coming v0.5.",
  "author": "GengyveUSA",
  "authorUrl": "https://github.com/gengyveusa",
  "fundingUrl": "",
  "isDesktopOnly": true
}
```

## Field rationale

| Field | Value | Why |
|---|---|---|
| `id` | `obsidian-claude-conduit` | The unique plugin id. **Cannot change** after first community-registry submission — choose carefully now. Matches the repo name. |
| `name` | `Sagittarius — Claude Conduit` | The user-facing name in Obsidian's plugin browser. The em-dash + tagline format matches Obsidian convention (e.g. *"Templater — Templates"*). |
| `version` | `0.1.0` | Semver. Bumps on every release. v0.1.0 = first read-only build. Coordinated bump in `package.json` and `versions.json` via `npm run version-bump`. |
| `minAppVersion` | `1.4.0` | Obsidian 1.4 introduced view types we depend on (verify at scaffold time; bump if needed). |
| `description` | (one-liner) | Shows in plugin browser. ≤150 chars per Obsidian convention. Names what v0.1 does + signals what's coming. |
| `author` | `GengyveUSA` | Org name, not personal. Matches the GitHub org. |
| `authorUrl` | `https://github.com/gengyveusa` | Links to the org. Not Thad's personal profile. |
| `fundingUrl` | `""` | Empty for v0.1. Bump to GitHub Sponsors / OpenCollective in v1.0 if Thad wants to invite community sponsorship. |
| `isDesktopOnly` | `true` | Per [[20-Decisions/2026-05-04-sagittarius-q1-q3-signoff\|ADR-007 bonus]]: desktop-only v1.0, mobile v1.1+. Forces Obsidian to hide the plugin on iOS/Android. |

## Coordinated files

The Obsidian plugin ecosystem requires three files to bump together on release:

1. `manifest.json` — this file (`version` field)
2. `package.json` — npm package (`version` field, must match)
3. `versions.json` — Obsidian compatibility map (`{"0.1.0": "1.4.0", ...}` — maps plugin version → minAppVersion)

The `npm run version-bump` script handles all three atomically. Manual edits to one file without the others = release-time confusion.

## What `id` cannot be

Per Obsidian community plugin guidelines:

- ❌ Cannot start with "obsidian-" — wait, **this is conventionally allowed but discouraged for new plugins.** The community guideline (as of cutoff) suggests avoiding the `obsidian-` prefix. **Reconsider:** rename to `claude-conduit` for the id?
- ❌ Cannot collide with an existing plugin id in the registry — search before submitting.

**Curator's call (low-confidence):** keep `obsidian-claude-conduit` for the id. The repo name is locked-in and the `obsidian-` prefix is grandfathered into many plugins (e.g. `obsidian-git`, `obsidian-kanban`). If the registry submission gets pushback, rename to `claude-conduit` and ship as `0.2.0`.

This is a **Phase 2 scaffold question** — answer at the moment we register, not now.

## What goes in `versions.json`

```json
{
  "0.1.0": "1.4.0"
}
```

Single entry at v0.1. Grows on each release.

## v0.1 release checklist (against this manifest)

When v0.1 is ready (per [[18-Obsidian-Claude-Plugin/02_SPEC|02_SPEC §8]] acceptance gates):

1. `npm run version-bump` to set version → 0.1.0 across all three files.
2. `npm run build` to produce `main.js`.
3. `git tag v0.1.0`.
4. `gh release create v0.1.0 main.js manifest.json versions.json styles.css` — uploads the assets BRAT needs.
5. Update README with installation instructions.
6. Submit BRAT-installable note: users add `gengyveusa/obsidian-claude-conduit` in the BRAT plugin's settings.
7. **Do NOT submit to `obsidianmd/obsidian-releases` yet.** Per [[20-Decisions/2026-05-04-sagittarius-build-commitment\|ADR-009]] — community submission is after v0.3.0 (~Phase 5).

## Related

- [[18-Obsidian-Claude-Plugin/02_SPEC]] — the spec this manifest describes
- [[18-Obsidian-Claude-Plugin/03_PACKAGE_JSON]] — npm side
- [[20-Decisions/2026-05-04-sagittarius-build-process]] — ADR-010 release flow
