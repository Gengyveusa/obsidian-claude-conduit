/**
 * Phase 6.5 (v0.9.0) — MCP bridge auth helpers per
 * [ADR-021](../../docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md) D3.
 *
 * Bearer-token auth: plugin generates a 32-byte random token on first
 * enable, shows it once in settings, hashes it at rest. Every incoming
 * MCP request carries `Authorization: Bearer <token>`; the server
 * SHA-256-hashes the candidate and compares against the stored hash
 * with a timing-safe equality check.
 *
 * Pure functions — no I/O, no Obsidian deps. Trivially testable.
 */

/**
 * Generate a fresh bearer token. 32 random bytes encoded as base64url
 * (URL-safe, no padding) → 43-char string. Random source is
 * `crypto.getRandomValues` which is available in both Node and the
 * Electron renderer that hosts Obsidian.
 */
export function generateBearerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Hash a token with SHA-256. Returns a hex string. Used both when
 * persisting (settings.mcpToken stores the hash, never the raw token)
 * and when verifying (incoming token is hashed then compared).
 */
export async function hashToken(token: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hexEncode(new Uint8Array(digest));
}

/**
 * Constant-time comparison of two hex strings. Returns true iff both
 * strings have identical length and identical bytes. Protects against
 * timing-attack token recovery. Returns false on any length mismatch
 * without scanning bytes.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a candidate bearer token against a stored hash. Returns true
 * iff `sha256(candidate) === storedHash` under timing-safe compare.
 * The stored hash must be lower-case hex; `hashToken` produces that.
 */
export async function verifyToken(
  candidate: string,
  storedHash: string,
): Promise<boolean> {
  if (candidate.length === 0 || storedHash.length === 0) {
    return false;
  }
  const candidateHash = await hashToken(candidate);
  return timingSafeEqualHex(candidateHash, storedHash);
}

/**
 * Parse `Authorization: Bearer <token>` header. Returns the token, or
 * null if the header is missing/malformed/scheme is not `Bearer`. Case
 * for the scheme is matched insensitively per RFC 6750.
 */
export function parseBearerHeader(header: string | null | undefined): string | null {
  if (header === null || header === undefined) {
    return null;
  }
  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) {
    return null;
  }
  const scheme = trimmed.slice(0, space).toLowerCase();
  if (scheme !== 'bearer') {
    return null;
  }
  const token = trimmed.slice(space + 1).trim();
  return token.length > 0 ? token : null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
