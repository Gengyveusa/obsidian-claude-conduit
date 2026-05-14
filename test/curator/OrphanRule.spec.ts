import { describe, expect, it } from 'vitest';

import {
  ORPHAN_RULE_NAME,
  archiveFolderFor,
  makeOrphanRule,
  severityFromAge,
} from '../../src/curator/rules/OrphanRule';
import type { CorpusStat, CuratorCorpus } from '../../src/curator/types';

class FakeCorpus implements CuratorCorpus {
  files: Map<string, { content: string; mtime: number; size: number; inbound: string[] }> = new Map();

  add(path: string, mtimeMs: number, inbound: string[] = []): this {
    this.files.set(path, { content: '', mtime: mtimeMs, size: 0, inbound });
    return this;
  }

  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
  read(path: string): Promise<string> {
    return Promise.resolve(this.files.get(path)?.content ?? '');
  }
  stat(path: string): Promise<CorpusStat | null> {
    const f = this.files.get(path);
    if (f === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ mtime: f.mtime, ctime: f.mtime, size: f.size });
  }
  outboundLinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
  backlinks(path: string): Promise<string[]> {
    return Promise.resolve(this.files.get(path)?.inbound ?? []);
  }
}

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('severityFromAge', () => {
  it('returns 0.4 at exactly the threshold', () => {
    expect(severityFromAge(90, 90)).toBe(0.4);
  });
  it('returns 0.4 below the threshold (clamped)', () => {
    expect(severityFromAge(30, 90)).toBe(0.4);
  });
  it('rises linearly between threshold and 4× threshold', () => {
    // At 2× threshold, ratio = (90/270) = 1/3 → 0.4 + 0.4/3 = 0.533...
    expect(severityFromAge(180, 90)).toBeCloseTo(0.533, 2);
    // At 4× threshold, full range.
    expect(severityFromAge(360, 90)).toBeCloseTo(0.8, 5);
  });
  it('caps at 0.8 beyond 4× threshold', () => {
    expect(severityFromAge(10_000, 90)).toBe(0.8);
  });
});

describe('archiveFolderFor', () => {
  it('uses UTC year of the mtime', () => {
    // 2024-06-15T12:00:00Z
    const ts = Date.UTC(2024, 5, 15, 12);
    expect(archiveFolderFor(ts)).toBe('_archive/2024');
  });

  it('correctly handles year boundaries', () => {
    expect(archiveFolderFor(Date.UTC(2024, 11, 31, 23, 59))).toBe('_archive/2024');
    expect(archiveFolderFor(Date.UTC(2025, 0, 1, 0, 0))).toBe('_archive/2025');
  });
});

describe('makeOrphanRule', () => {
  it('reports an orphan that exceeds the staleness threshold', async () => {
    const corpus = new FakeCorpus();
    corpus.add('forgotten.md', NOW - 120 * DAY_MS);
    const rule = makeOrphanRule({ staleThresholdDays: 90, now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleName).toBe(ORPHAN_RULE_NAME);
    expect(findings[0].notePath).toBe('forgotten.md');
    expect(typeof findings[0].severity).toBe('number');
    expect(findings[0].payload).toMatchObject({ staleDays: 120 });
  });

  it('skips notes with inbound links even if stale', async () => {
    const corpus = new FakeCorpus();
    corpus.add('referenced.md', NOW - 365 * DAY_MS, ['some-other.md']);
    const rule = makeOrphanRule({ staleThresholdDays: 90, now: () => NOW });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('skips notes below the staleness threshold even if orphaned', async () => {
    const corpus = new FakeCorpus();
    corpus.add('fresh.md', NOW - 30 * DAY_MS);
    const rule = makeOrphanRule({ staleThresholdDays: 90, now: () => NOW });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('skips notes in ignored folders (default: _archive, _logs)', async () => {
    const corpus = new FakeCorpus();
    corpus.add('_archive/2020/old.md', NOW - 1000 * DAY_MS);
    corpus.add('_logs/2024-05.md', NOW - 1000 * DAY_MS);
    corpus.add('regular/old.md', NOW - 1000 * DAY_MS);
    const rule = makeOrphanRule({ staleThresholdDays: 90, now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings.map((f) => f.notePath)).toEqual(['regular/old.md']);
  });

  it('respects a custom ignoredFolders list', async () => {
    const corpus = new FakeCorpus();
    corpus.add('drafts/old.md', NOW - 1000 * DAY_MS);
    corpus.add('keep/this.md', NOW - 1000 * DAY_MS);
    const rule = makeOrphanRule({
      staleThresholdDays: 90,
      ignoredFolders: ['drafts'],
      now: () => NOW,
    });
    const findings = await rule.detect(corpus);
    expect(findings.map((f) => f.notePath)).toEqual(['keep/this.md']);
  });

  it('uses the threshold default of 90 when not specified', async () => {
    const corpus = new FakeCorpus();
    corpus.add('old.md', NOW - 95 * DAY_MS);
    corpus.add('newer.md', NOW - 80 * DAY_MS);
    const rule = makeOrphanRule({ now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings.map((f) => f.notePath)).toEqual(['old.md']);
  });

  it('computes archive folder from the note mtime year', async () => {
    const corpus = new FakeCorpus();
    const mtime = Date.UTC(2023, 7, 10);
    // We want the note to be stale; use a "now" far enough out.
    const now = mtime + 200 * DAY_MS;
    corpus.add('relic.md', mtime);
    const rule = makeOrphanRule({ staleThresholdDays: 90, now: () => now });
    const findings = await rule.detect(corpus);
    expect(findings[0].payload).toMatchObject({ archiveFolder: '_archive/2023' });
  });
});
