import { describe, expect, it } from 'vitest';

import {
  STALE_NOTE_RULE_NAME,
  makeStaleNoteRule,
  severityFromAge,
} from '../../src/curator/rules/StaleNoteRule';
import type { CorpusStat, CuratorCorpus } from '../../src/curator/types';

class FakeCorpus implements CuratorCorpus {
  files: Map<string, number> = new Map();

  add(path: string, mtimeMs: number): this {
    this.files.set(path, mtimeMs);
    return this;
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
  read(): Promise<string> {
    return Promise.resolve('');
  }
  stat(p: string): Promise<CorpusStat | null> {
    const m = this.files.get(p);
    if (m === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ mtime: m, ctime: m, size: 0 });
  }
  outboundLinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
  backlinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('severityFromAge (stale-note)', () => {
  it('returns 0.3 at threshold', () => {
    expect(severityFromAge(180, 180)).toBe(0.3);
  });
  it('returns 0.3 below threshold (clamp)', () => {
    expect(severityFromAge(50, 180)).toBe(0.3);
  });
  it('caps at 0.7 beyond 4× threshold', () => {
    expect(severityFromAge(10_000, 180)).toBe(0.7);
  });
});

describe('makeStaleNoteRule', () => {
  it('reports notes stale past the threshold', async () => {
    const corpus = new FakeCorpus();
    corpus.add('a.md', NOW - 200 * DAY_MS);
    const rule = makeStaleNoteRule({ staleThresholdDays: 180, now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleName).toBe(STALE_NOTE_RULE_NAME);
    expect(findings[0].payload).toMatchObject({ staleDays: 200 });
  });

  it('skips fresh notes', async () => {
    const corpus = new FakeCorpus();
    corpus.add('a.md', NOW - 30 * DAY_MS);
    const rule = makeStaleNoteRule({ staleThresholdDays: 180, now: () => NOW });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('skips ignored folders (_archive, _logs, 10-Inbox)', async () => {
    const corpus = new FakeCorpus();
    corpus.add('_archive/old.md', NOW - 1000 * DAY_MS);
    corpus.add('_logs/log.md', NOW - 1000 * DAY_MS);
    corpus.add('10-Inbox/note.md', NOW - 1000 * DAY_MS);
    corpus.add('regular/note.md', NOW - 1000 * DAY_MS);
    const rule = makeStaleNoteRule({ staleThresholdDays: 180, now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings.map((f) => f.notePath)).toEqual(['regular/note.md']);
  });

  it('reports unlike OrphanRule even when inbound links exist', async () => {
    // The fake corpus's backlinks() always returns []; StaleNoteRule
    // doesn't actually call it (it ignores links). Verify the rule
    // doesn't care about inbound count.
    const corpus = new FakeCorpus();
    corpus.add('referenced-but-old.md', NOW - 500 * DAY_MS);
    const rule = makeStaleNoteRule({ staleThresholdDays: 180, now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
  });

  it('uses 180-day default threshold', async () => {
    const corpus = new FakeCorpus();
    corpus.add('old.md', NOW - 200 * DAY_MS);
    corpus.add('newer.md', NOW - 100 * DAY_MS);
    const rule = makeStaleNoteRule({ now: () => NOW });
    const findings = await rule.detect(corpus);
    expect(findings.map((f) => f.notePath)).toEqual(['old.md']);
  });
});
