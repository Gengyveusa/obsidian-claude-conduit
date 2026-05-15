import { describe, expect, it } from 'vitest';

import { hashToken } from '../../src/mcp/auth';
import {
  authenticateBearerHeader,
  deriveLegacyScope,
  lookupBearerToken,
  migrateLegacyToken,
  RESERVED_TOKEN_NAMES,
  scopeAllows,
  validateTokenName,
} from '../../src/mcp/tokens';
import type { McpTokenEntry, SagittariusSettings } from '../../src/settings/types';

async function entry(name: string, scope: McpTokenEntry['scope'], rawToken: string): Promise<McpTokenEntry> {
  return {
    name,
    hash: await hashToken(rawToken),
    scope,
    createdAt: 1_700_000_000,
    lastUsedAt: null,
  };
}

function baseSettings(over: Partial<SagittariusSettings> = {}): SagittariusSettings {
  return {
    mcpToken: '',
    mcpTokens: [],
    mcpWriteEnabled: false,
    mcpHighRiskToolsEnabled: false,
    ...over,
  } as unknown as SagittariusSettings;
}

describe('lookupBearerToken', () => {
  it('returns ok:false when the array is empty', async () => {
    const result = await lookupBearerToken('anything', []);
    expect(result).toEqual({ ok: false, entry: null });
  });

  it('returns ok:false when the candidate is empty', async () => {
    const tokens = [await entry('a', 'read', 'rawAlpha')];
    expect(await lookupBearerToken('', tokens)).toEqual({ ok: false, entry: null });
  });

  it('finds the matching entry when the candidate hashes to it', async () => {
    const a = await entry('a', 'read', 'rawAlpha');
    const b = await entry('b', 'write', 'rawBeta');
    const result = await lookupBearerToken('rawBeta', [a, b]);
    expect(result.ok).toBe(true);
    expect(result.entry?.name).toBe('b');
    expect(result.entry?.scope).toBe('write');
  });

  it('returns ok:false when no entry matches', async () => {
    const a = await entry('a', 'read', 'rawAlpha');
    const result = await lookupBearerToken('not-the-real-token', [a]);
    expect(result.ok).toBe(false);
  });

  it('iterates ALL entries (no early exit) for constant-time matching', async () => {
    // We can't directly observe timing, but we can confirm a match at
    // position N works the same way as at position 0.
    const entries = await Promise.all(
      Array.from({ length: 10 }, (_, i) => entry(`t${i}`, 'read', `tok${i}`)),
    );
    const first = await lookupBearerToken('tok0', entries);
    const last = await lookupBearerToken('tok9', entries);
    expect(first.entry?.name).toBe('t0');
    expect(last.entry?.name).toBe('t9');
  });
});

describe('authenticateBearerHeader', () => {
  it('parses the header + looks up the token', async () => {
    const tokens = [await entry('cursor', 'write', 'rawCursor')];
    const result = await authenticateBearerHeader('Bearer rawCursor', tokens);
    expect(result.ok).toBe(true);
    expect(result.entry?.name).toBe('cursor');
  });

  it('rejects malformed Authorization headers', async () => {
    const tokens = [await entry('cursor', 'write', 'rawCursor')];
    expect((await authenticateBearerHeader(null, tokens)).ok).toBe(false);
    expect((await authenticateBearerHeader('rawCursor', tokens)).ok).toBe(false); // no Bearer scheme
    expect((await authenticateBearerHeader('Bearer ', tokens)).ok).toBe(false); // empty value
  });

  it('rejects when no tokens are configured', async () => {
    expect((await authenticateBearerHeader('Bearer anything', [])).ok).toBe(false);
  });
});

describe('migrateLegacyToken (D10)', () => {
  it('migrates a populated mcpToken into a `legacy` entry', () => {
    const s = baseSettings({ mcpToken: 'pre-hashed' });
    const changed = migrateLegacyToken(s);
    expect(changed).toBe(true);
    expect(s.mcpToken).toBe('');
    expect(s.mcpTokens).toHaveLength(1);
    expect(s.mcpTokens[0].name).toBe('legacy');
    expect(s.mcpTokens[0].hash).toBe('pre-hashed');
    expect(s.mcpTokens[0].scope).toBe('read'); // no toggles set
  });

  it('derives scope from current global toggles', () => {
    const s1 = baseSettings({ mcpToken: 'h', mcpWriteEnabled: true });
    migrateLegacyToken(s1);
    expect(s1.mcpTokens[0].scope).toBe('write');

    const s2 = baseSettings({
      mcpToken: 'h',
      mcpWriteEnabled: true,
      mcpHighRiskToolsEnabled: true,
    });
    migrateLegacyToken(s2);
    expect(s2.mcpTokens[0].scope).toBe('delete');
  });

  it('is a no-op when mcpToken is empty', () => {
    const s = baseSettings();
    expect(migrateLegacyToken(s)).toBe(false);
    expect(s.mcpTokens).toEqual([]);
  });

  it('is a no-op when mcpTokens is already populated (idempotent)', async () => {
    const s = baseSettings({
      mcpToken: 'legacy-hash',
      mcpTokens: [await entry('cursor', 'write', 'rawCursor')],
    });
    expect(migrateLegacyToken(s)).toBe(false);
    expect(s.mcpToken).toBe('legacy-hash'); // untouched
    expect(s.mcpTokens).toHaveLength(1);
    expect(s.mcpTokens[0].name).toBe('cursor'); // not overwritten
  });
});

describe('deriveLegacyScope', () => {
  it('returns "read" when neither write nor high-risk are enabled', () => {
    expect(deriveLegacyScope({ mcpWriteEnabled: false, mcpHighRiskToolsEnabled: false })).toBe('read');
  });
  it('returns "write" when only write is enabled', () => {
    expect(deriveLegacyScope({ mcpWriteEnabled: true, mcpHighRiskToolsEnabled: false })).toBe('write');
  });
  it('returns "delete" when both write and high-risk are enabled', () => {
    expect(deriveLegacyScope({ mcpWriteEnabled: true, mcpHighRiskToolsEnabled: true })).toBe('delete');
  });
  it('returns "delete" when only high-risk is set (defensive — implies write too)', () => {
    expect(deriveLegacyScope({ mcpWriteEnabled: false, mcpHighRiskToolsEnabled: true })).toBe('delete');
  });
});

describe('validateTokenName (D4)', () => {
  it('accepts simple kebab-case names', () => {
    expect(validateTokenName('claude-desktop')).toBeNull();
    expect(validateTokenName('cursor')).toBeNull();
    expect(validateTokenName('cline')).toBeNull();
    expect(validateTokenName('openai_codex')).toBeNull();
  });

  it('accepts names with numerals', () => {
    expect(validateTokenName('a1')).toBeNull();
    expect(validateTokenName('client-v2')).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(validateTokenName('')).toMatch(/required/);
  });

  it('rejects names over 40 chars', () => {
    expect(validateTokenName('a'.repeat(41))).toMatch(/40 characters or fewer/);
  });

  it('rejects uppercase characters', () => {
    expect(validateTokenName('Cursor')).toMatch(/lowercase/);
  });

  it('rejects names starting with a hyphen or underscore', () => {
    expect(validateTokenName('-foo')).toMatch(/start with a letter or digit/);
    expect(validateTokenName('_foo')).toMatch(/start with a letter or digit/);
  });

  it('rejects spaces + special characters', () => {
    expect(validateTokenName('claude desktop')).toMatch(/lowercase/);
    expect(validateTokenName('claude.desktop')).toMatch(/lowercase/);
  });

  it('rejects reserved names', () => {
    expect(validateTokenName('legacy')).toMatch(/reserved/);
    expect(RESERVED_TOKEN_NAMES.has('legacy')).toBe(true);
  });
});

describe('scopeAllows (D2)', () => {
  it('read scope allows only read tools', () => {
    expect(scopeAllows('read', 'read')).toBe(true);
    expect(scopeAllows('read', 'write')).toBe(false);
    expect(scopeAllows('read', 'high-risk')).toBe(false);
  });

  it('write scope allows read + write but not high-risk', () => {
    expect(scopeAllows('write', 'read')).toBe(true);
    expect(scopeAllows('write', 'write')).toBe(true);
    expect(scopeAllows('write', 'high-risk')).toBe(false);
  });

  it('delete scope allows everything (strict superset)', () => {
    expect(scopeAllows('delete', 'read')).toBe(true);
    expect(scopeAllows('delete', 'write')).toBe(true);
    expect(scopeAllows('delete', 'high-risk')).toBe(true);
  });
});
