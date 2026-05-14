import { describe, expect, it } from 'vitest';

import {
  WRITE_TOOL_PATH_FIELDS,
  WriteRateLimiter,
  evaluateWriteGate,
  type WriteGateSettings,
} from '../../src/mcp/WriteGate';

const defaultSettings: WriteGateSettings = {
  mcpWriteEnabled: true,
  mcpHighRiskToolsEnabled: false,
  mcpWriteAllowedClients: [],
  mcpWritePathPrefixes: ['10-Inbox/'],
};

describe('evaluateWriteGate — master toggle (D1)', () => {
  it('denies any write when mcpWriteEnabled is false', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpWriteEnabled: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('master-off');
    }
  });
});

describe('evaluateWriteGate — high-risk toggle (D1)', () => {
  it('denies delete_note when high-risk toggle is off', () => {
    const result = evaluateWriteGate(
      'delete_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpHighRiskToolsEnabled: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('high-risk-off');
    }
  });

  it('permits delete_note when high-risk toggle is on', () => {
    const result = evaluateWriteGate(
      'delete_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpHighRiskToolsEnabled: true },
    );
    expect(result.ok).toBe(true);
  });

  it('treats non-high-risk write tools as not gated by high-risk toggle', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpHighRiskToolsEnabled: false },
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateWriteGate — per-client allowlist (D6)', () => {
  it('permits any authenticated client when allowlist is empty', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpWriteAllowedClients: [] },
    );
    expect(result.ok).toBe(true);
  });

  it('permits a listed client', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpWriteAllowedClients: ['claude-desktop'] },
    );
    expect(result.ok).toBe(true);
  });

  it('denies a client absent from a non-empty allowlist', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/foo.md' },
      'mcp:claude-code',
      { ...defaultSettings, mcpWriteAllowedClients: ['claude-desktop'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('client-forbidden');
    }
  });

  it('matches against the bare client name (strips the mcp: prefix)', () => {
    // The handler stores `mcp:<name>` internally; the allowlist holds raw names.
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/foo.md' },
      'mcp:writer-bot',
      { ...defaultSettings, mcpWriteAllowedClients: ['writer-bot'] },
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateWriteGate — path scope (D7)', () => {
  it('permits a path under any allowed prefix', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '10-Inbox/draft.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpWritePathPrefixes: ['10-Inbox/', '20-Notes/'] },
    );
    expect(result.ok).toBe(true);
  });

  it('denies a path outside every allowed prefix', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: '30-Decisions/important.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpWritePathPrefixes: ['10-Inbox/'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('path-scope');
      expect(result.reason).toContain('30-Decisions/important.md');
    }
  });

  it('checks BOTH from and to for move/rename — denies if either is outside scope', () => {
    const result = evaluateWriteGate(
      'move_note',
      { from: '10-Inbox/foo.md', to: '30-Outside/foo.md' },
      'mcp:claude-desktop',
      defaultSettings,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('path-scope');
    }
  });

  it('permits move_note when both ends are in scope', () => {
    const result = evaluateWriteGate(
      'move_note',
      { from: '10-Inbox/foo.md', to: '10-Inbox/bar.md' },
      'mcp:claude-desktop',
      defaultSettings,
    );
    expect(result.ok).toBe(true);
  });

  it('returns arg-missing when a required path field is absent', () => {
    const result = evaluateWriteGate(
      'create_note',
      { content: 'no path here' },
      'mcp:claude-desktop',
      defaultSettings,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('arg-missing');
    }
  });

  it('skips path-scope check entirely when prefixes are empty (D7 default escape hatch)', () => {
    const result = evaluateWriteGate(
      'create_note',
      { path: 'anywhere/at/all.md' },
      'mcp:claude-desktop',
      { ...defaultSettings, mcpWritePathPrefixes: [] },
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateWriteGate — gate priority', () => {
  it('master-off shortcircuits before any other gate', () => {
    // High-risk tool, wrong client, bad path — all would deny — but master
    // off is reported first because it's the most important signal for
    // the operator ("turn it on first, then we can discuss the rest").
    const result = evaluateWriteGate(
      'delete_note',
      { path: '99-Vault-Root/precious.md' },
      'mcp:unknown-client',
      {
        mcpWriteEnabled: false,
        mcpHighRiskToolsEnabled: false,
        mcpWriteAllowedClients: ['claude-desktop'],
        mcpWritePathPrefixes: ['10-Inbox/'],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('master-off');
    }
  });

  it('high-risk denial precedes client-forbidden', () => {
    const result = evaluateWriteGate(
      'delete_note',
      { path: '10-Inbox/foo.md' },
      'mcp:unknown-client',
      {
        ...defaultSettings,
        mcpHighRiskToolsEnabled: false,
        mcpWriteAllowedClients: ['claude-desktop'],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('high-risk-off');
    }
  });
});

describe('WRITE_TOOL_PATH_FIELDS', () => {
  it('covers every write tool exposed in v1.0.9', () => {
    // Mirrors MCP_WRITE_TOOL_NAMES + MCP_HIGH_RISK_TOOL_NAMES (10 entries).
    expect(Object.keys(WRITE_TOOL_PATH_FIELDS).sort()).toEqual([
      'add_frontmatter',
      'append_to_note',
      'create_note',
      'delete_note',
      'file_asset',
      'link_notes',
      'move_note',
      'patch_note',
      'rename_note',
      'rewrite_section',
    ]);
  });

  it('lists both ends for move/rename/link', () => {
    expect(WRITE_TOOL_PATH_FIELDS.move_note).toEqual(['from', 'to']);
    expect(WRITE_TOOL_PATH_FIELDS.rename_note).toEqual(['from', 'to']);
    expect(WRITE_TOOL_PATH_FIELDS.link_notes).toEqual(['from', 'to']);
  });
});

describe('WriteRateLimiter', () => {
  it('permits up to the limit then denies the next attempt', () => {
    const limiter = new WriteRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryConsume(t0 + i, 3).ok).toBe(true);
    }
    const denied = limiter.tryConsume(t0 + 4, 3);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe('rate-limited');
    }
  });

  it('evicts hits older than the rolling 1-hour window', () => {
    const limiter = new WriteRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      limiter.tryConsume(t0 + i, 3);
    }
    // Advance past the window relative to the LATEST hit (t0+2) so all
    // three pre-window hits are evicted before the new attempt.
    const tLater = t0 + 2 + 3_600_001;
    expect(limiter.tryConsume(tLater, 3).ok).toBe(true);
    expect(limiter.pendingCount(tLater)).toBe(1);
  });

  it('treats limit <= 0 as disabled (always permits)', () => {
    const limiter = new WriteRateLimiter();
    for (let i = 0; i < 100; i++) {
      expect(limiter.tryConsume(i, 0).ok).toBe(true);
    }
  });

  it('updates limit at call time — same limiter can hit different caps', () => {
    const limiter = new WriteRateLimiter();
    expect(limiter.tryConsume(1, 5).ok).toBe(true);
    expect(limiter.tryConsume(2, 5).ok).toBe(true);
    // Tighten the cap mid-flight: count is now 2, limit drops to 2 → deny next.
    const denied = limiter.tryConsume(3, 2);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe('rate-limited');
    }
  });
});
