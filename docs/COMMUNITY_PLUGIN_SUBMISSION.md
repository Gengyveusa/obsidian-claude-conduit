# Community plugin registry submission

This document is the **ready-to-file** material for getting Sagittarius
into the Obsidian community plugin registry. File the PR yourself
(it requires your GitHub account + reading the reviewer feedback);
this doc just stages the artifacts so you don't have to assemble
them under deadline.

## What you're submitting

A PR against [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)
that adds one entry to the `community-plugins.json` file (it's a
JSON array of plugin entries). Once merged, Sagittarius appears in
the in-app **Settings → Community Plugins → Browse** list for every
Obsidian user.

## Pre-submission checklist

Verified against the [official submission requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins) as of 2026-05-15:

- [x] `manifest.json` has `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly`, `fundingUrl`
- [x] `id` matches the GitHub repo name (`obsidian-claude-conduit`)
- [x] `description` opens action-based ("Chat with your vault…") per the style guide; ends with a period; ≤250 chars; no emoji
- [x] First public release exists at the GitHub URL with `main.js`, `manifest.json`, `styles.css` attached as separate files (see [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)); release tag matches `manifest.json` version exactly (no `v` prefix)
- [x] LICENSE file exists (we ship MIT)
- [x] README has Install, Setup, and Usage sections
- [x] No `console.log` in production code (verified — only one match is in a JSDoc `@example` block)
- [x] No hardcoded user paths (`/Users/...`, `C:\...`)
- [x] All network calls use Obsidian's `requestUrl()` not raw `fetch` (CORS in renderer process; v1.3.1 swapped the one localhost MCP probe to be safe)
- [x] No bundled `jquery` / `lodash` / `moment` (verified)
- [x] Tested on macOS + Windows (`isDesktopOnly: true`; iOS / Android N/A)

## The JSON entry

Add this object to `community-plugins.json` (it's a giant array; alphabetic
order by id is conventional but not strictly required):

```json
{
  "id": "obsidian-claude-conduit",
  "name": "Sagittarius — Claude Conduit",
  "author": "GengyveUSA",
  "description": "Chat with your vault using Claude. Generate cited drafts, edit notes through diff-first proposals, surface CLAUDE.md memory at every turn, and bridge to Claude Desktop via MCP.",
  "repo": "gengyveusa/obsidian-claude-conduit"
}
```

The `description` matches `manifest.json` exactly so reviewers don't have
to reconcile two strings.

## PR title + body template

**Title:**

```
Add plugin: Sagittarius — Claude Conduit
```

**Body:**

```markdown
# I am submitting a new Community Plugin

## Repo URL

Link to my plugin: https://github.com/gengyveusa/obsidian-claude-conduit

## Release Checklist
- [x] I have tested the plugin on
  - [x] Windows
  - [x] macOS
  - [ ] Linux
  - [x] iOS — N/A (`isDesktopOnly: true`)
  - [x] Android — N/A (`isDesktopOnly: true`)
- [x] My GitHub release contains all required files (as individual files, not just in a source.zip)
  - [x] `main.js`
  - [x] `manifest.json`
  - [x] `styles.css`
- [x] GitHub release name matches the exact version number specified in my manifest.json (no `v` prefix)
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file
- [x] My README.md describes the plugin's purpose and provides clear usage instructions
- [x] I have read the developer policies at https://docs.obsidian.md/Developer+policies, and have assessed my plugin's adherence to these policies
- [x] I have read the tips in https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines and have self-reviewed my plugin to avoid these common pitfalls
- [x] I have added a LICENSE file to the GitHub repository
- [x] My plugin only uses `requestUrl` instead of `fetch` or `XMLHttpRequest`
```

> Replace the platform check-marks with what you've actually tested.
> The reviewers will close the PR if you over-claim.

## What happens next

1. A bot validates the JSON and the manifest fields automatically.
2. A human reviewer (Obsidian team or a community moderator) reads the README, scans the source for common issues, and either:
   - Approves and merges (Sagittarius is live within a few hours)
   - Requests changes (typical: a `console.log` left in, a missing field, a description tweak)
3. If changes are requested, push to your **plugin** repo's main branch (NOT to the obsidian-releases PR), then comment on the PR that you've addressed the feedback.

Typical turnaround: 3-14 days for first review. Subsequent updates
to your plugin (after the registry entry is in) don't need new PRs;
the registry pulls the latest GitHub release automatically.

## Likely reviewer flags + pre-emptive answers

| Flag | Answer |
|---|---|
| "Why `dangerouslyAllowBrowser: true` on the Anthropic SDK?" | Required because Obsidian runs renderer-side; the SDK's browser guard is a Node-environment check that doesn't apply to Electron renderers with isolated process contexts. The risk it guards against (key exposure to a third-party page) doesn't apply here — the renderer runs only Obsidian + plugin code, no third-party JS. |
| "Plugin is 2 MB — that's huge" | sql.js (WASM) + onnxruntime-web are inlined per ADR-011 so distribution stays a single `main.js`. Splitting requires a dynamic-loader story Obsidian doesn't support natively. Tradeoff is conscious. |
| "Why does it need network access?" | (a) Anthropic API for chat (user-provided key, opt-in via Settings). (b) HuggingFace API for embeddings, optional — without an HF token Sagittarius gracefully degrades to chat-mode + 4 non-search tools. (c) Outbound localhost-only HTTP server for the MCP bridge, off by default. No telemetry, no analytics. |
| "Why does it need write access to the vault?" | The plugin's primary capability is helping the user edit notes via the diff card. ADR-016 D2: every write surfaces a diff card for user approval before any byte hits disk. Read the [`docs/`](.) folder for the full ADR set. |

## After acceptance

- [ ] Update the README's Install section to add "Settings → Community Plugins → Browse → search Sagittarius" as the recommended path
- [ ] Update the project `CLAUDE.md` status line
- [ ] Bump to v1.4.0 to mark "first registry release" milestone (optional but conventional)
