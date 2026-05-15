import { describe, expect, it } from 'vitest';

import type { CuratorCorpus } from '../../../src/curator/types';
import {
  buildTagCensus,
  makeDraftSuggestionRule,
  type DraftSuggestionPayload,
} from '../../../src/curator/rules/DraftSuggestionRule';

class FakeCorpus implements CuratorCorpus {
  files = new Map<string, string>();
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(v);
  }
  stat(): Promise<null> {
    return Promise.resolve(null);
  }
  outboundLinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
  backlinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

function note(tags: ReadonlyArray<string>, body = '# Note\n\nbody'): string {
  return ['---', `tags: [${tags.map((t) => `'${t}'`).join(', ')}]`, '---', '', body].join('\n');
}

function synthesisNote(tags: ReadonlyArray<string>): string {
  return [
    '---',
    `tags: [${tags.map((t) => `'${t}'`).join(', ')}]`,
    'type: synthesis',
    '---',
    '',
    '# Synthesis',
  ].join('\n');
}

describe('buildTagCensus', () => {
  it('collects tags from frontmatter array', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set('a.md', note(['project', 'q3']));
    corpus.files.set('b.md', note(['project']));
    const census = await buildTagCensus(corpus);
    expect(census.tagToNotes.get('project')?.size).toBe(2);
    expect(census.tagToNotes.get('q3')?.size).toBe(1);
  });

  it('collects inline #tags from body, skipping code fences', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set(
      'a.md',
      'A note about #soltura and #q3.\n\n```\n# this is a heading not a tag\n#NOT-a-real-tag-in-code\n```\n',
    );
    const census = await buildTagCensus(corpus);
    expect(census.tagToNotes.has('soltura')).toBe(true);
    expect(census.tagToNotes.has('q3')).toBe(true);
    expect(census.tagToNotes.has('NOT-a-real-tag-in-code')).toBe(false);
  });

  it('flags tags that have a `type: synthesis` note', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set('a.md', note(['project']));
    corpus.files.set('synth.md', synthesisNote(['project']));
    const census = await buildTagCensus(corpus);
    expect(census.tagsWithSynthesis.has('project')).toBe(true);
  });

  it('flags tags by filename containing "synthesis"/"summary"/"overview"', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set('a.md', note(['project']));
    corpus.files.set('project-summary.md', note(['project']));
    const census = await buildTagCensus(corpus);
    expect(census.tagsWithSynthesis.has('project')).toBe(true);
  });

  it('preserves tag case (#Project ≠ #project)', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set('a.md', note(['Project']));
    corpus.files.set('b.md', note(['project']));
    const census = await buildTagCensus(corpus);
    expect(census.tagToNotes.get('Project')?.size).toBe(1);
    expect(census.tagToNotes.get('project')?.size).toBe(1);
  });
});

describe('makeDraftSuggestionRule', () => {
  it('emits a finding for tags with >= minNotes notes and no synthesis', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 5; i++) {
      corpus.files.set(`note-${i}.md`, note(['q3']));
    }
    const rule = makeDraftSuggestionRule({ minNotes: 5 });
    const findings = await rule.detect(corpus);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleName).toBe('draft-suggestion');
    expect(findings[0].reason).toMatch(/5 notes tagged `#q3`/);
    const payload = findings[0].payload as unknown as DraftSuggestionPayload;
    expect(payload.tag).toBe('q3');
    expect(payload.memberCount).toBe(5);
    expect(payload.suggestedTopic).toBe('Synthesis of #q3 notes');
  });

  it('does not emit when tag has < minNotes', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set('a.md', note(['q3']));
    corpus.files.set('b.md', note(['q3']));
    const rule = makeDraftSuggestionRule({ minNotes: 5 });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('does not emit when a synthesis note already exists for the tag', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 10; i++) {
      corpus.files.set(`note-${i}.md`, note(['q3']));
    }
    corpus.files.set('q3-synth.md', synthesisNote(['q3']));
    const rule = makeDraftSuggestionRule({ minNotes: 5 });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('skips the default-ignored structural tags', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 10; i++) {
      corpus.files.set(`inbox-${i}.md`, note(['inbox']));
      corpus.files.set(`wip-${i}.md`, note(['wip']));
      corpus.files.set(`moc-${i}.md`, note(['moc']));
    }
    const rule = makeDraftSuggestionRule({ minNotes: 5 });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('respects custom ignoreTags', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 10; i++) {
      corpus.files.set(`note-${i}.md`, note(['boring']));
    }
    const rule = makeDraftSuggestionRule({ minNotes: 5, ignoreTags: ['boring'] });
    expect(await rule.detect(corpus)).toEqual([]);
  });

  it('severity scales with member count, capped at 1.0', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 10; i++) {
      corpus.files.set(`a-${i}.md`, note(['ten']));
    }
    for (let i = 0; i < 30; i++) {
      corpus.files.set(`b-${i}.md`, note(['thirty']));
    }
    const rule = makeDraftSuggestionRule({ minNotes: 5 });
    const findings = await rule.detect(corpus);
    const ten = findings.find((f) => (f.payload as unknown as DraftSuggestionPayload).tag === 'ten');
    const thirty = findings.find((f) => (f.payload as unknown as DraftSuggestionPayload).tag === 'thirty');
    expect(ten?.severity).toBeCloseTo(0.5, 5);
    expect(thirty?.severity).toBe(1.0); // capped
  });

  it('default minNotes is 5', async () => {
    const corpus = new FakeCorpus();
    for (let i = 0; i < 4; i++) {
      corpus.files.set(`note-${i}.md`, note(['four']));
    }
    for (let i = 0; i < 5; i++) {
      corpus.files.set(`other-${i}.md`, note(['five']));
    }
    const rule = makeDraftSuggestionRule(); // no opts
    const findings = await rule.detect(corpus);
    expect(findings.map((f) => (f.payload as unknown as DraftSuggestionPayload).tag)).toEqual(['five']);
  });

  it('attaches a sorted member list in the payload', async () => {
    const corpus = new FakeCorpus();
    corpus.files.set('z.md', note(['x']));
    corpus.files.set('a.md', note(['x']));
    corpus.files.set('m.md', note(['x']));
    corpus.files.set('p.md', note(['x']));
    corpus.files.set('q.md', note(['x']));
    const rule = makeDraftSuggestionRule({ minNotes: 5 });
    const finding = (await rule.detect(corpus))[0];
    const payload = finding.payload as unknown as DraftSuggestionPayload;
    expect(payload.members).toEqual(['a.md', 'm.md', 'p.md', 'q.md', 'z.md']);
  });
});
