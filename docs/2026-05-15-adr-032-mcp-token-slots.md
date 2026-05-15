---
title: "ADR-032: Per-client MCP token slots (v1.4.2 substrate)"
type: decision
status: "Accepted (D1-D10 batch-accepted 2026-05-15)"
date: 2026-05-15
---

## Context

Phase 6.5/6.7 shipped the MCP bridge with a **single** authentication
token (settings.mcpToken — sha-256 hash of a randomly-generated raw
token). One token serves every client that connects: Claude Desktop,
Cursor, Cline, OpenAI Codex, etc.

That's fine for "one operator, three trusted local clients" but
breaks down the moment operators want:

- **Revoke one client without breaking others** — rotate Cursor's
  access after pushing it to a teammate, keep Claude Desktop alive.
- **Scope per client** — give Cline read-only, give Claude Desktop
  full write, give Cursor write but not delete.
- **Audit which client did what** — when `create_note` proposals queue
  in the External Proposals side panel, which MCP client sent them?
- **Disable one path without nuking the bridge** — temporarily kill
  Cursor's token without flipping the global on/off.

The global `mcpWriteEnabled` + `mcpDeleteEnabled` toggles per ADR-025
D2 give coarse on/off control but no per-client granularity. This
ADR adds per-token scopes + an array of named tokens, with a
migration path from the single-token shape.

Scope of this work: **substrate-level patch**, not a phase. Ships as
v1.4.2. ~1.5-2 hours of work. Touches settings schema, McpServer
auth, McpHandler scope enforcement, External Proposals labeling,
and a new settings UI section.

This ADR follows the ADR-026/ADR-029 template — 10 decisions, batch-
accept. Same-session implementation per ADR-010 §4.

## Goals

- **Multiple named tokens**, each scoped independently
- **Backward-compatible migration** from the single-token state
- **Visible audit trail** in the External Proposals panel
- **Operator-revocable** per token, without affecting others
- **No breaking change** for current users who never touched MCP

## Decisions

### D1. Settings shape — array of token entries replaces the single string.

**Selected:** new field `mcpTokens: TokenEntry[]` replaces `mcpToken: string`.

```ts
export interface McpTokenEntry {
  /** Operator-supplied label, e.g. 'claude-desktop', 'cursor', 'cline'. */
  name: string;
  /** sha-256 hash of the raw token. Raw value shown ONCE on generation. */
  hash: string;
  /** Per-token capability ceiling per D2. */
  scope: 'read' | 'write' | 'delete';
  /** Epoch ms; for the settings UI's chronological view. */
  createdAt: number;
  /** Epoch ms of last successful auth. `null` if never used. */
  lastUsedAt: number | null;
}
```

The legacy `mcpToken` string field is **kept** in the type but
deprecated; it serves only the migration path (D10). After v1.4.2,
the codebase reads from `mcpTokens` exclusively.

### D2. Three scope tiers — `read` / `write` / `delete`.

**Selected:**

| Scope | Read tools (5) | Write tools (9) | `delete_note` |
|---|---|---|---|
| `read` | ✅ | ❌ | ❌ |
| `write` | ✅ | ✅ | ❌ |
| `delete` | ✅ | ✅ | ✅ |

`delete` is a strict superset of `write`, which is a strict superset
of `read`. The tools-list response (per MCP spec) filters per-token:
a `read`-scoped token sees only the 5 read tools when it calls
`tools/list`, so the client can't even attempt a forbidden call.

**Why not 4 tiers (separate delete posture):** delete is the only
truly destructive tool. Bundling it as the third tier is a clear
"this token can do everything including the dangerous thing" signal,
which matches operator mental models.

### D3. Global toggles become circuit breakers, not capability gates.

**Selected:** `settings.mcpWriteEnabled` and `settings.mcpDeleteEnabled`
remain, but their semantics change:

- **Both off + any token tries to write/delete** → 403 (or MCP error code -32602 "method not found")
- **Both off + read** → still allowed (the bridge itself is up; read tokens still work)
- **mcpEnabled = false** → bridge entirely down, all tokens denied

Globals are now **upper-bound circuit breakers**: a token's scope can
do at most what the global allows. A `delete`-scoped token with
`mcpDeleteEnabled = false` is effectively a `write` token. A
`write`-scoped token with `mcpWriteEnabled = false` is effectively
`read`.

**Why this layering:** the global toggle is the panic-kill switch
("disable all writes from anywhere right now"); per-token scopes are
the day-to-day permission model. Both useful for different situations.

### D4. Token name format — kebab-case, 1-40 chars, unique.

**Selected:**

- Regex: `^[a-z0-9][a-z0-9_-]{0,39}$` — lowercase alphanumeric, optional underscores/dashes, must start alphanumeric
- Unique within `mcpTokens` (case-sensitive)
- Reserved names: `legacy` (used by D10 migration); operator can't create new tokens with this name

UI validates on generate; rejects duplicates with a Notice.

### D5. Hash algorithm — keep sha-256, document why.

**Selected:** sha-256 over the raw token bytes, hex-encoded. Same as
the current `hashToken` implementation (which already exists from
Phase 6.5).

**Why not bcrypt / scrypt / argon2:** those are designed for
**low-entropy user-chosen passwords** where you need slow hashing to
resist brute force. Sagittarius generates **high-entropy random**
tokens (>= 30 bytes from crypto.getRandomValues). A fast hash is
fine; an attacker who has access to the hash file already has the
machine. Don't introduce a heavier dep for no real gain.

The hash function lives in a single helper (`src/mcp/auth.ts` —
already exists) so the algorithm can be swapped later if needs change.

### D6. Last-used tracking — persist on every successful auth.

**Selected:** on each authenticated call, update the matching token's
`lastUsedAt` to `Date.now()` and persist settings.

**Persist immediately, not debounced:** settings saves are cheap
(JSON write to plugin data file). The audit value of "this token was
last used 23 seconds ago" outweighs the IO cost. If real-world
profiling later shows it's hot, debounce; for now, straight write.

### D7. Settings UI — table + generate flow.

**Selected:**

```
┌─────────────────────────────────────────────────────────────┐
│ MCP tokens                                                  │
│                                                             │
│  claude-desktop    [write]    last used 2 min ago    [Revoke]│
│  cursor            [write]    last used 1 hr ago     [Revoke]│
│  cline             [read]     never used             [Revoke]│
│                                                             │
│  [+ Generate new token]                                     │
└─────────────────────────────────────────────────────────────┘
```

Table rows: name | scope chip | last-used (relative, "2 min ago" / "never") | Revoke button.

**Generate flow:**
1. Click **+ Generate new token**
2. Modal: name input (validated per D4) + scope dropdown (D2) + Create button
3. On Create: produces raw token (32 random bytes, hex-encoded ~64 chars), stores hash + entry, shows raw token ONCE in a read-only field with a Copy button + a "I've saved it" dismiss
4. After dismiss, raw token is gone (no way to recover; operator must regenerate if lost)

**Revoke flow:** confirm dialog → delete entry → save settings → revoke takes effect immediately on next auth attempt.

### D8. External Proposals labeling — token name on every proposal.

**Selected:** when a write proposal queues from MCP (per ADR-025 the
external queue model), the proposal metadata gains a
`mcpTokenName: string | null` field. The side panel renders it:

```
┌──────────────────────────────────────────────────────────────┐
│ Pending proposals (2)                                        │
│                                                              │
│  📝 create_note  30-Projects/q3.md                            │
│     from: claude-desktop  ·  2 min ago                       │
│     [View diff]  [Accept]  [Reject]                          │
│                                                              │
│  ✂️  patch_note  30-Projects/sagittarius.md                   │
│     from: cursor  ·  5 min ago                               │
│     [View diff]  [Accept]  [Reject]                          │
└──────────────────────────────────────────────────────────────┘
```

OS notification text also includes the token name: *"Sagittarius:
`create_note` from claude-desktop pending review."*

In-app proposals (the chat panel calling write tools) leave
`mcpTokenName: null` — the existing "from chat" label still applies.

### D9. Revocation + regeneration are explicit operations.

**Selected:** two distinct ops on each token:

- **Revoke** — hard-delete the entry from `mcpTokens`. Auth fails
  immediately. Operator must update the consuming client's config
  with a fresh token (or remove the MCP server from that config).
- **Regenerate** — produce a new raw token under the same name +
  scope; replace the hash; reset `lastUsedAt` to null. Old hash dead
  immediately; operator copies the new raw token into the client.

The settings UI surfaces both. Regenerate is the "rotate this client's
credentials" path; revoke is the "this client is dead to me" path.

### D10. Migration — single-string token becomes a `legacy` entry.

**Selected:** on plugin load, if `settings.mcpToken` is non-empty AND
`settings.mcpTokens` is empty:

```ts
mcpTokens = [{
  name: 'legacy',
  hash: settings.mcpToken,                    // already hashed
  scope: deriveLegacyScope(settings),         // see below
  createdAt: Date.now(),
  lastUsedAt: null,
}];
settings.mcpToken = '';                       // clear the old slot
```

`deriveLegacyScope` returns the scope the existing global toggles
would have allowed:

```ts
function deriveLegacyScope(s: SagittariusSettings): McpTokenEntry['scope'] {
  if (s.mcpDeleteEnabled) return 'delete';
  if (s.mcpWriteEnabled) return 'write';
  return 'read';
}
```

**Migration is one-way + idempotent.** Once `mcpTokens` is non-empty,
the plugin never touches `mcpToken` again. Operators with brand-new
installs never see `mcpToken` populated; their first generation goes
straight into `mcpTokens`.

The `legacy` name is reserved (per D4) so operators can't accidentally
create a second `legacy` entry. They can revoke it and create
properly-named replacements at their leisure.

## Risks / open questions

- **OQ1:** if an operator has multiple Obsidian vaults (each with
  their own plugin install), each vault has its own token list. That
  might be desired (per-vault security) but worth surfacing in docs.
- **OQ2:** the "show raw token once" UI is a usability cliff —
  operators who close the dialog without copying lose the token and
  must regenerate. Acceptable for security; worth a clear warning
  + a copy-to-clipboard button.
- **OQ3:** future need: per-token TTL (auto-expire after N days).
  Not in scope for v1.4.2 but the schema (`createdAt` + a future
  `expiresAt`) supports adding it later.

## Related

- [ADR-025](2026-05-14-adr-025-phase-6.7-mcp-write-side-plan.md) —
  Phase 6.7 plan; introduced the global `mcpWriteEnabled` +
  `mcpDeleteEnabled` toggles this ADR converts to circuit breakers.
- [ADR-027](2026-05-14-phase-6.7-close.md) — Phase 6.7 close; the
  External Proposals queue D8 extends with token names.
- [ADR-016](2026-05-10-adr-016-phase-4-plan.md) — D2 (every write
  through the diff card) still holds; this ADR doesn't touch the
  approval surface, just the auth + labeling layer.
- [ADR-010](2026-05-04-sagittarius-build-process.md) §4 — process;
  D1-D10 await batch acceptance, then same-session implementation.

## After acceptance

Implementation plan (one session):

1. **Settings schema** — add `mcpTokens` array + migration code
2. **McpServer auth** — replace single-hash lookup with array
   iteration + scope return
3. **McpHandler scope enforcement** — filter `tools/list` per scope;
   reject `tools/call` for out-of-scope tools
4. **ExternalProposalQueue** — add `mcpTokenName` field; thread
   through to the panel + notification
5. **Settings UI** — table + generate modal + revoke confirmation
6. **Tests** — schema migration, scope enforcement, hash lookup,
   panel labeling
7. **Version bump** v1.4.2; CHANGELOG entry; CLAUDE.md status
