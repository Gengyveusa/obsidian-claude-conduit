import { describe, expect, it } from 'vitest';

import {
  FALLBACK_CONSTITUTION,
  FALLBACK_HANGAR_VOICE,
  loadSystemPromptParts,
} from '../../src/obsidian/SystemPromptLoader';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';

class FakeVaultAdapter implements VaultAdapter {
  constructor(
    private readonly files: Map<string, string>,
    private readonly readErrors: Set<string> = new Set(),
  ) {}

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  read(path: string): Promise<string> {
    if (this.readErrors.has(path)) {
      return Promise.reject(new Error('synthetic read failure'));
    }
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error('not found'));
    }
    return Promise.resolve(content);
  }

  readBinary(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  write(): Promise<void> {
    return Promise.resolve();
  }

  writeBinary(): Promise<void> {
    return Promise.resolve();
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }

  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
}

const opts = {
  constitutionPath: 'THAD_MAN.md',
  hangarVoicePath: '21-Agents/concierge.md',
};

describe('loadSystemPromptParts', () => {
  it('returns vault contents when both files exist and are non-empty', async () => {
    const adapter = new FakeVaultAdapter(
      new Map([
        ['THAD_MAN.md', '# Constitution body'],
        ['21-Agents/concierge.md', '# Hangar voice body'],
      ]),
    );
    const parts = await loadSystemPromptParts(adapter, opts);
    expect(parts.constitution).toBe('# Constitution body');
    expect(parts.hangarVoice).toBe('# Hangar voice body');
  });

  it('falls back to bundled constitution when the vault file is missing', async () => {
    const adapter = new FakeVaultAdapter(
      new Map([['21-Agents/concierge.md', '# Voice body']]),
    );
    const parts = await loadSystemPromptParts(adapter, opts);
    expect(parts.constitution).toBe(FALLBACK_CONSTITUTION);
    expect(parts.hangarVoice).toBe('# Voice body');
  });

  it('falls back to bundled hangar voice when its file is missing', async () => {
    const adapter = new FakeVaultAdapter(
      new Map([['THAD_MAN.md', '# Constitution']]),
    );
    const parts = await loadSystemPromptParts(adapter, opts);
    expect(parts.constitution).toBe('# Constitution');
    expect(parts.hangarVoice).toBe(FALLBACK_HANGAR_VOICE);
  });

  it('falls back to both defaults for a community install with neither file', async () => {
    const adapter = new FakeVaultAdapter(new Map());
    const parts = await loadSystemPromptParts(adapter, opts);
    expect(parts.constitution).toBe(FALLBACK_CONSTITUTION);
    expect(parts.hangarVoice).toBe(FALLBACK_HANGAR_VOICE);
  });

  it('treats empty files as fallback (whitespace-only does not count)', async () => {
    const adapter = new FakeVaultAdapter(
      new Map([
        ['THAD_MAN.md', '   \n\n  '],
        ['21-Agents/concierge.md', ''],
      ]),
    );
    const parts = await loadSystemPromptParts(adapter, opts);
    expect(parts.constitution).toBe(FALLBACK_CONSTITUTION);
    expect(parts.hangarVoice).toBe(FALLBACK_HANGAR_VOICE);
  });

  it('falls back when read throws (file disappeared between exists and read)', async () => {
    const adapter = new FakeVaultAdapter(
      new Map([['THAD_MAN.md', 'present']]),
      new Set(['THAD_MAN.md']),
    );
    const parts = await loadSystemPromptParts(adapter, opts);
    expect(parts.constitution).toBe(FALLBACK_CONSTITUTION);
  });
});
