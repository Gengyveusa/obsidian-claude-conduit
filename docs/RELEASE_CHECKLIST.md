# Release checklist (Phase 11)

Step-by-step for taking a versioned release public. Run this every
time `manifest.json`'s `version` bumps. ~30 minutes start to finish
for the first time; ~10 minutes thereafter.

## Pre-flight

Run from `main` after the version-bump PR has merged.

- [ ] On `main`, `git pull`, confirm `manifest.json`'s version matches the intent (e.g. `1.3.1`)
- [ ] `versions.json` has the matching `"<version>": "<minAppVersion>"` entry
- [ ] `CHANGELOG.md` has a section for the new version
- [ ] `npm run lint && npm run typecheck && npx vitest run` — all green
- [ ] `npm run build` — produces `main.js` (~2 MB; sql.js + onnxruntime-web inlined)

## Tag the release

```bash
VERSION=1.3.1     # match manifest.json
git tag -a "$VERSION" -m "v$VERSION"
git push origin "$VERSION"
```

> Note: Obsidian's plugin-registry submission requires the tag to be
> the *bare version number* (no `v` prefix). The `-a` flag creates an
> annotated tag (carries metadata; required for some downstream tools).

## Build the release artifacts

```bash
npm run build
# Confirm these three exist at the repo root:
ls -la main.js manifest.json styles.css
```

The Obsidian community-plugin loader expects all three files at the
root of the GitHub release (NOT inside a zip).

## Create the GitHub release

Web UI:

1. **Releases → Draft a new release**
2. **Choose a tag:** select the tag you just pushed (e.g. `1.3.1`)
3. **Release title:** `v1.3.1 — <one-line summary>`
4. **Description:** copy the matching section from `CHANGELOG.md`
5. **Attach binaries:** drag-drop `main.js`, `manifest.json`, `styles.css` from the repo root
6. **Publish release**

CLI (if `gh` is installed and configured):

```bash
gh release create "$VERSION" main.js manifest.json styles.css \
  --title "v$VERSION — <summary>" \
  --notes-file CHANGELOG-$VERSION.md
```

## Verify BRAT install

- [ ] In a test Obsidian vault: BRAT → **Add Beta Plugin** → `gengyveusa/obsidian-claude-conduit` → confirm it picks up the new version
- [ ] Reload Obsidian; verify the plugin loads and the version in Settings shows `$VERSION`
- [ ] Spot-check: open chat panel, run a quick question, confirm no console errors

## Submit to the Obsidian community plugin registry (first-time only)

For the **first** public release, file a PR to
[`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases)
adding Sagittarius to `community-plugins.json`. See
[`docs/COMMUNITY_PLUGIN_SUBMISSION.md`](./COMMUNITY_PLUGIN_SUBMISSION.md)
for the JSON entry + PR template.

For subsequent releases, registry users get the new version
automatically once the GitHub release is published — no further
submission needed.

## Announce (optional)

- [ ] Tweet / Mastodon / wherever
- [ ] Update the project's own `CLAUDE.md` status line if anything changed about how to talk about the project
- [ ] Cross-post in r/ObsidianMD or the Obsidian Discord `#plugin-dev` channel

## Post-release

- [ ] Open a `claude/v$NEXT-...` branch for the next slice; keep `main` clean
- [ ] If the release introduced a feature flag, set a calendar reminder to revisit the default in 2 weeks
