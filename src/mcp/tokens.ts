import type { McpTokenEntry, SagittariusSettings } from '../settings/types';

import { hashToken, parseBearerHeader, timingSafeEqualHex } from './auth';

/**
 * Phase 6.7+ (v1.4.2) — MCP token-list helpers per
 * [ADR-032](../../docs/2026-05-15-adr-032-mcp-token-slots.md).
 *
 * Pure(-ish) module: hashing is async, but the helpers below take
 * pre-computed hashes where possible and don't touch I/O. The
 * migration helper (D10) is the only one that mutates settings.
 */

/** Result of looking up a candidate bearer token against the array. */
export interface TokenLookup {
  ok: boolean;
  /** The matching entry on success; null on failure. */
  entry: McpTokenEntry | null;
}

/**
 * Hash the candidate bearer token once and compare against every
 * stored hash with timing-safe equality. Returns the matching entry
 * on hit, `{ok: false, entry: null}` on miss.
 *
 * Constant-time across all entries by virtue of hashing the candidate
 * once and running `timingSafeEqualHex` for every entry — early-exit
 * is deliberately avoided so the iteration count doesn't leak which
 * (if any) token matched.
 *
 * @example
 *   const lookup = await lookupBearerToken('raw-token', tokens);
 *   if (lookup.ok) { applyScope(lookup.entry); }
 */
export async function lookupBearerToken(
  candidate: string,
  tokens: ReadonlyArray<McpTokenEntry>,
): Promise<TokenLookup> {
  if (candidate.length === 0 || tokens.length === 0) {
    return { ok: false, entry: null };
  }
  const candidateHash = await hashToken(candidate);
  let match: McpTokenEntry | null = null;
  for (const entry of tokens) {
    // Don't break on hit — iterate all entries so timing doesn't
    // leak which slot matched. timingSafeEqualHex is constant-time
    // already, but the iteration count must also be.
    if (timingSafeEqualHex(candidateHash, entry.hash)) {
      match = entry;
    }
  }
  return match === null ? { ok: false, entry: null } : { ok: true, entry: match };
}

/**
 * Extract + look up a bearer token from a raw Authorization header.
 * Convenience wrapper combining `parseBearerHeader` and
 * `lookupBearerToken`.
 */
export async function authenticateBearerHeader(
  authHeader: string | null | undefined,
  tokens: ReadonlyArray<McpTokenEntry>,
): Promise<TokenLookup> {
  const candidate = parseBearerHeader(authHeader);
  if (candidate === null) {
    return { ok: false, entry: null };
  }
  return lookupBearerToken(candidate, tokens);
}

/**
 * D10 migration helper — call this once on plugin load. When the
 * legacy single-token field is non-empty AND the new array is empty,
 * convert the legacy hash into a named `legacy` entry whose scope is
 * derived from the current global toggles (`mcpWriteEnabled`,
 * `mcpHighRiskToolsEnabled`).
 *
 * Returns `true` if migration happened (caller should `saveData`),
 * `false` if no change was made. Idempotent: once `mcpTokens` is
 * non-empty, future calls are no-ops.
 *
 * @example
 *   if (migrateLegacyToken(this.settings)) {
 *     await this.saveSettings();
 *   }
 */
export function migrateLegacyToken(settings: SagittariusSettings): boolean {
  if (settings.mcpToken.length === 0) {
    return false;
  }
  if (settings.mcpTokens.length > 0) {
    return false;
  }
  settings.mcpTokens.push({
    name: 'legacy',
    hash: settings.mcpToken,
    scope: deriveLegacyScope(settings),
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  settings.mcpToken = '';
  return true;
}

/**
 * Map the existing global toggles to a scope tier per ADR-032 D10.
 * Highest privilege the toggles would have allowed becomes the
 * `legacy` entry's scope — operator can revoke + regenerate at a
 * narrower scope if desired.
 */
export function deriveLegacyScope(
  s: Pick<SagittariusSettings, 'mcpWriteEnabled' | 'mcpHighRiskToolsEnabled'>,
): McpTokenEntry['scope'] {
  if (s.mcpHighRiskToolsEnabled) {
    return 'delete';
  }
  if (s.mcpWriteEnabled) {
    return 'write';
  }
  return 'read';
}

/**
 * Names that operators can't claim — currently just `legacy` (which
 * the migration owns).
 */
export const RESERVED_TOKEN_NAMES: ReadonlySet<string> = new Set(['legacy']);

/**
 * Validate an operator-supplied token name per ADR-032 D4. Returns
 * `null` on success or a human-readable error string. Caller is
 * responsible for checking uniqueness against the existing array.
 *
 * Rules:
 *   - 1-40 chars
 *   - `^[a-z0-9][a-z0-9_-]{0,39}$` (start alphanumeric; lowercase
 *     alphanumeric + `-` + `_` body)
 *   - Not in RESERVED_TOKEN_NAMES
 */
export function validateTokenName(name: string): string | null {
  if (name.length === 0) {
    return 'token name is required';
  }
  if (name.length > 40) {
    return 'token name must be 40 characters or fewer';
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    return 'token name must be lowercase letters/digits/_/- and start with a letter or digit';
  }
  if (RESERVED_TOKEN_NAMES.has(name)) {
    return `'${name}' is reserved`;
  }
  return null;
}

/**
 * Tools a given scope can see. `write` adds the 9 write tools to
 * `read`'s 5; `delete` adds `delete_note` on top. The caller
 * intersects this with the global circuit-breaker toggles
 * (`mcpWriteEnabled`, `mcpHighRiskToolsEnabled`) to produce the
 * final exposure set.
 *
 * Per ADR-032 D2, scopes are strict supersets.
 */
export function scopeAllows(
  scope: McpTokenEntry['scope'],
  toolCategory: 'read' | 'write' | 'high-risk',
): boolean {
  if (toolCategory === 'read') {
    return true;
  }
  if (toolCategory === 'write') {
    return scope === 'write' || scope === 'delete';
  }
  // high-risk
  return scope === 'delete';
}
