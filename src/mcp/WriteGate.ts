/**
 * Phase 6.7 (v1.0.9) write-side gates per ADR-025. Each function is a
 * pure boundary predicate that runs inside `McpHandler.onToolsCall`
 * BEFORE the tool's `handler()` produces a `Proposal`. Failure of any
 * gate aborts the call with a structured JSON-RPC error and the
 * diff card never opens.
 *
 * Gates layered in priority order:
 *   1. master-toggle  → `mcpWriteEnabled` (ADR-025 D1)
 *   2. high-risk gate → `mcpHighRiskToolsEnabled` for `delete_note` (D1)
 *   3. per-client     → `mcpWriteAllowedClients` (D6)
 *   4. path scope     → `mcpWritePathPrefixes` (D7)
 *   5. rate limit     → `mcpWriteRateLimitPerHour` (D9)
 *
 * Pure functions + one stateful class (`WriteRateLimiter`). Caller
 * composes — no I/O, no side effects on the gates themselves.
 */

/**
 * Map of MCP write tool name → arg keys whose values are vault-relative
 * paths. Path scope (D7) verifies every key listed here. For move /
 * rename, BOTH source and destination must be under the allowlist —
 * we don't want an MCP client moving a sensitive note into the inbox
 * (or out of it) just because one end of the move passes scope.
 */
export const WRITE_TOOL_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create_note: ['path'],
  append_to_note: ['path'],
  patch_note: ['path'],
  rewrite_section: ['path'],
  add_frontmatter: ['path'],
  move_note: ['from', 'to'],
  rename_note: ['from', 'to'],
  link_notes: ['from', 'to'],
  file_asset: ['path'],
  delete_note: ['path'],
};

/**
 * Structured reason a write-gate denied a call. Maps to a single
 * JSON-RPC error code at the caller; the `reason` field is the
 * user-actionable message that surfaces in the MCP response.
 */
export type WriteGateOutcome =
  | { ok: true }
  | {
      ok: false;
      /**
       * Stable token. UI / tests assert on this; `reason` is for humans.
       * `'master-off'` — `mcpWriteEnabled` is false.
       * `'high-risk-off'` — tool is in the high-risk tier and the
       *   `mcpHighRiskToolsEnabled` flag is off.
       * `'client-forbidden'` — `mcpWriteAllowedClients` is non-empty
       *   and the calling client isn't on it.
       * `'path-scope'` — at least one of the tool's path args falls
       *   outside `mcpWritePathPrefixes`.
       * `'rate-limited'` — global rolling-hour cap exceeded.
       * `'arg-missing'` — a required path arg is absent / non-string
       *   (defensive; Zod already validates, but the path-scope check
       *   runs before Zod inside the dispatcher).
       */
      code:
        | 'master-off'
        | 'high-risk-off'
        | 'client-forbidden'
        | 'path-scope'
        | 'rate-limited'
        | 'arg-missing';
      reason: string;
    };

export interface WriteGateSettings {
  mcpWriteEnabled: boolean;
  mcpHighRiskToolsEnabled: boolean;
  mcpWriteAllowedClients: ReadonlyArray<string>;
  mcpWritePathPrefixes: ReadonlyArray<string>;
}

/**
 * Run gates 1-4 against a write-tool call. Rate limit (gate 5) is its
 * own class because it needs state; check it separately at the call
 * site after this returns `ok: true`.
 *
 * `clientName` is the value `McpHandler` captured during `initialize`
 * (`'mcp:<client>'` or `'mcp'`). The per-client check strips the
 * `'mcp:'` prefix to compare against the allowlist's raw client names.
 */
export function evaluateWriteGate(
  toolName: string,
  args: unknown,
  clientName: string,
  settings: WriteGateSettings,
): WriteGateOutcome {
  if (!settings.mcpWriteEnabled) {
    return {
      ok: false,
      code: 'master-off',
      reason: 'MCP write-side is disabled. Enable it in Sagittarius settings → MCP write-side.',
    };
  }
  if (isHighRiskName(toolName) && !settings.mcpHighRiskToolsEnabled) {
    return {
      ok: false,
      code: 'high-risk-off',
      reason:
        `Tool '${toolName}' is in the high-risk tier (ADR-025 D1). ` +
        `Enable "Allow high-risk tools" in Sagittarius settings to permit it via MCP.`,
    };
  }
  if (settings.mcpWriteAllowedClients.length > 0) {
    const rawClient = stripMcpPrefix(clientName);
    if (!settings.mcpWriteAllowedClients.includes(rawClient)) {
      return {
        ok: false,
        code: 'client-forbidden',
        reason:
          `Client '${rawClient}' is not in the write-allowed list. ` +
          `Read access may still work via the regular allowlist.`,
      };
    }
  }
  if (settings.mcpWritePathPrefixes.length > 0) {
    const fields = WRITE_TOOL_PATH_FIELDS[toolName];
    if (fields === undefined) {
      // Unknown write tool — should be unreachable when the caller has
      // already verified the tool is on the write-tools allowlist.
      return {
        ok: false,
        code: 'arg-missing',
        reason: `Path-scope check has no field map for tool '${toolName}'.`,
      };
    }
    const argsObj = isPlainObject(args) ? args : {};
    for (const field of fields) {
      const value = argsObj[field];
      if (typeof value !== 'string' || value.length === 0) {
        return {
          ok: false,
          code: 'arg-missing',
          reason: `Tool '${toolName}' is missing required path arg '${field}'.`,
        };
      }
      if (!pathMatchesAnyPrefix(value, settings.mcpWritePathPrefixes)) {
        return {
          ok: false,
          code: 'path-scope',
          reason:
            `Path '${value}' is outside the MCP write-path allowlist. ` +
            `Allowed prefixes: ${settings.mcpWritePathPrefixes.join(', ')}.`,
        };
      }
    }
  }
  return { ok: true };
}

function pathMatchesAnyPrefix(path: string, prefixes: ReadonlyArray<string>): boolean {
  for (const p of prefixes) {
    if (p.length === 0) {
      continue;
    }
    if (path.startsWith(p)) {
      return true;
    }
  }
  return false;
}

function isHighRiskName(name: string): boolean {
  return name === 'delete_note';
}

function stripMcpPrefix(clientName: string): string {
  return clientName.startsWith('mcp:') ? clientName.slice(4) : clientName;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Rolling 60-minute write-attempt counter per ADR-025 D9. State is in
 * memory only — restarts reset the window, which is fine for a soft
 * cap intended to catch runaway loops rather than prevent persistent
 * abuse. (Persistent abuse from an authenticated client should be
 * resolved by revoking the token, not by rate limit.)
 *
 * `limit` is supplied per-call so settings changes apply immediately
 * without rebuilding the limiter (and losing the in-flight window).
 * Pass `0` to disable.
 *
 * @example
 *   const limiter = new WriteRateLimiter();
 *   const outcome = limiter.tryConsume(Date.now(), settings.mcpWriteRateLimitPerHour);
 *   if (!outcome.ok) {
 *     return errorResponse(req.id, JSON_RPC_ERROR.SERVER_ERROR, outcome.reason);
 *   }
 */
export class WriteRateLimiter {
  private readonly hits: number[] = [];

  /**
   * Attempt to record one write proposal at `nowMs` against `limit`
   * proposals/hour. Returns `{ ok: true }` and bumps the counter on
   * success; returns `{ ok: false, code: 'rate-limited' }` if the
   * rolling 60-minute window already holds `limit` entries.
   */
  tryConsume(nowMs: number, limit: number): WriteGateOutcome {
    const windowStart = nowMs - 3_600_000;
    while (this.hits.length > 0 && this.hits[0] < windowStart) {
      this.hits.shift();
    }
    if (limit <= 0) {
      // Disabled — still evict expired hits above so memory doesn't grow,
      // but always permit.
      this.hits.push(nowMs);
      return { ok: true };
    }
    if (this.hits.length >= limit) {
      return {
        ok: false,
        code: 'rate-limited',
        reason:
          `MCP write rate limit reached (${limit}/hour). ` +
          'Retry after the rolling window clears.',
      };
    }
    this.hits.push(nowMs);
    return { ok: true };
  }

  /** Test seam — count of recorded hits inside the rolling window at `nowMs`. */
  pendingCount(nowMs: number): number {
    const windowStart = nowMs - 3_600_000;
    return this.hits.filter((t) => t >= windowStart).length;
  }
}
