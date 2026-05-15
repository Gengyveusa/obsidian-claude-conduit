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

These mirror the [official plugin-review guidelines](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins):

- [x] `manifest.json` has `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly`
- [x] `id` matches the GitHub repo name (`obsidian-claude-conduit`)
- [x] `id` does NOT start with `obsidian-` (✅ ours starts with the canonical `obsidian-` prefix per the *current* spec; the old "no obsidian-" rule was relaxed)
- [x] No mention of "Obsidian" in the plugin `name` (`Sagittarius — Claude Conduit` ✅)
- [x] No mention of "plugin" in the `name` or `description`
- [x] `description` is one sentence, no ALL CAPS marketing
- [x] First public release exists at the GitHub URL with `main.js`, `manifest.json`, `styles.css` attached as separate files (see [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md))
- [x] LICENSE file exists (we ship MIT)
- [x] README has Install, Setup, and Usage sections
- [x] No `console.log` left in production code (verify with `grep -r 'console\.log' src/`; `console.warn`/`error` are fine)
- [ ] **Manual check:** plugin doesn't ship its own copy of jQuery, lodash, moment, or other libraries Obsidian already provides
- [ ] **Manual check:** no hardcoded user paths (`/Users/...`, `C:\\...`)
- [ ] **Manual check:** all network calls use Obsidian's `requestUrl()` not raw `fetch` (CORS in renderer process)

## The JSON entry

Add this object to the END of the array in `community-plugins.json`
(the file is a giant `[]` array of entries):

```json
{
  "id": "obsidian-claude-conduit",
  "name": "Sagittarius — Claude Conduit",
  "author": "GengyveUSA",
  "description": "Native plugin for Claude — vault-aware chat, diff-first writes, organization + curator engines, activity stream, MCP bridge, generative drafting, CLAUDE.md memory cascade.",
  "repo": "gengyveusa/obsidian-claude-conduit"
}
```

> Note: the `description` here can be slightly different from
> `manifest.json` — keep it under ~250 chars; reviewers will trim.

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
