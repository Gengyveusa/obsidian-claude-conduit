---
title: "ADR-015: VaultAdapter audit (Phase 3 cleanup #3)"
type: decision
status: "Accepted"
date: 2026-05-10
---

## Context

Third Phase 3 cleanup item from [ADR-014](2026-05-09-phase-3-close.md). The v0.2.x cycle exposed silent-fail behavior in `adapter.list('')` — a class of bug that "works in test fakes, fails in production." This ADR records a live audit of every other `VaultAdapter` method against a real Obsidian vault (Stephen's, 358 markdown files) to identify the next failure of this shape before Phase 4 (Write Layer) starts exercising the write methods.

## Audit method

In-renderer console probe against `app.vault.adapter` directly:
- 9 probes across `list` / `exists` / `stat` / `mkdir` / `write` covering: empty path, root slash, valid path, trailing slash, nonexistent path, recursive mkdir, write without parent dir.
- Each probe wrapped in try/catch; ok-or-throw + duration + truncated result captured.
- Probes left a `_sagittarius-audit-tmp/` dir which was cleaned up afterward.

## Findings

### Surprise: `list('')` works in current Obsidian

Both `list('')` and `list('/')` return the full root listing (folders + files) successfully. **No throw, no silent empty result.** This contradicts the root-cause narrative in ADR-014 and v0.2.3's commit message, which both attributed the v0.2.0-v0.2.2 "0 notes / 0 chunks" indexer failure to `list('')` throwing inside the BFS walker's silent try/catch.

We never actually proved that hypothesis — we replaced the walker with `getMarkdownFiles()` and the symptom disappeared. The fix (use Obsidian's canonical enumeration API) is still the right architectural choice, but the **diagnosis was speculation, not evidence**. The real root cause remains unknown:

- Possibilities: an interaction with the conversation-log `excludePathPrefixes`, a path-normalization bug in our `isExcluded` check, a per-folder throw deeper in the recursion, or an Obsidian version-specific bug fixed in a later release.
- We won't dig further. The current architecture (`getMarkdownFiles()`) sidesteps all of these.

### Confirmed: `mkdir()` is recursive

`adapter.mkdir('_sagittarius-audit-tmp/a/b/c')` succeeded and created all three intermediate dirs in one call. Both production callers (`ConversationLogger`, `IndexPersistence`) rely on this behavior; the contract holds. **No code change needed.**

### Real bug: `write()` does NOT auto-mkdir

`adapter.write('_sagittarius-audit-tmp/missing-dir/x.md', 'hi')` threw `ENOENT` and the file was NOT created. Production callers (`ConversationLogger`, `IndexPersistence`) currently dodge this by calling `mkdir(parentDir)` before every write. That convention works for v0.1-0.2 (only two write paths), but **Phase 4 (Write Layer) introduces 9 write tools**: `create_note`, `patch_note`, `append_to_note`, `move_note`, `rename_note`, `link_notes`, `add_frontmatter`, `rewrite_section`, `file_asset`. Each one would need to remember the mkdir dance, or they'd silently break when the LLM proposes writing to a not-yet-existing folder (a likely common case).

**v0.2.6 fix**: `VaultAdapterImpl.write()` and `writeBinary()` now derive the parent dir from the path and call `mkdir(parent)` defensively before delegating to the inner adapter. Callers can stop worrying about it. Tests verify the new behavior.

### Confirmed: other methods are well-behaved

- `exists('')` / `exists('/')` → `true` (no throw).
- `stat('')` → returns a folder stat object.
- `stat('does-not-exist')` → returns `null` (documented contract).
- `list('does-not-exist')` → throws `ENOENT` (real throw, not silent).
- Trailing slashes (`list('foo/')` vs `list('foo')`) → identical behavior.

### Pre-existing gap: path-traversal validation

v0.1 spec §7 threat model requires every tool to validate `realpath(input).startsWith(vault_root)` and error if not. **Not implemented anywhere.** Out of scope for this ADR; flagged as a Phase 4 prerequisite — the write tools must enforce this before they can land safely. Without it, a prompt-injected LLM could write `../../../etc/passwd` (or its Mac equivalent) and exfiltrate or destroy data outside the vault.

## Decision

1. **Auto-mkdir on write.** Modify `VaultAdapterImpl.write()` and `writeBinary()` to call `mkdir(parent)` before the inner write. Document the new contract on the `VaultAdapter` interface.
2. **Correct the v0.2.3 narrative.** Add a clarifying note to ADR-014 and to the in-source `Indexer.ts` comment that the walker's actual failure mode was never proven — `getMarkdownFiles()` was adopted on architectural merit, not as a confirmed fix for `list('')` specifically.
3. **Defer path-traversal validation.** Tracked as a Phase 4 prerequisite ADR (to be written before write-tool code lands).

## Follow-ups (Phase 4 prereqs)

- [ ] Path-traversal validation helper that every write tool calls (`assertInVault(adapter, inputPath)` or similar). Spec §7 binding.
- [ ] Write-conflict detection: what if the user edited the file in Obsidian between when Claude read it and when Claude writes the diff? Probably involves stat-mtime comparison or hash-on-read.
- [ ] Atomicity across multi-tool transactions: how does undo work when the agent makes 3 writes and the 3rd fails?
- [ ] Inspect remaining `app.vault.adapter` direct uses (e.g. SystemCheck which uses `adapter.basePath` via the underlying DataAdapter) to ensure they go through `VaultAdapter` only.

## Related

- [ADR-014](2026-05-09-phase-3-close.md) — Phase 3 close. This ADR amends ADR-014's v0.2.3 root-cause narrative.
- [`docs/02_SPEC.md`](02_SPEC.md) — §7 threat model defines the path-traversal requirement.
- [`docs/05_CONDUIT_AGENT_SKETCH.md`](05_CONDUIT_AGENT_SKETCH.md) — agent class shape; Phase 4 will extend ToolRegistry with write tools.
