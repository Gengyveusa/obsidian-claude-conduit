import { describe, expect, it } from 'vitest';

import { parseJournalResponse } from '../../src/memory/JournalGenerator';

describe('parseJournalResponse', () => {
  it('extracts all four bullets from a clean response', () => {
    const text = [
      '- **Worked on:** drafted ADR-033 for Phase 12',
      '- **Decided:** ship MVP operator-triggered first',
      '- **Learned about operator:** prefers tight planning ADRs',
      '- **Open threads:** v1.4.2 tag/release pending',
    ].join('\n');
    const section = parseJournalResponse(text);
    expect(section.workedOn).toBe('drafted ADR-033 for Phase 12');
    expect(section.decided).toBe('ship MVP operator-triggered first');
    expect(section.learnedAboutOperator).toBe('prefers tight planning ADRs');
    expect(section.openThreads).toBe('v1.4.2 tag/release pending');
  });

  it('tolerates `*` bullet marker in addition to `-`', () => {
    const text = '* **Worked on:** alt marker';
    expect(parseJournalResponse(text).workedOn).toBe('alt marker');
  });

  it('tolerates missing markdown emphasis', () => {
    const text = '- Worked on: bare label\n- Decided: also bare';
    const section = parseJournalResponse(text);
    expect(section.workedOn).toBe('bare label');
    expect(section.decided).toBe('also bare');
  });

  it('tolerates underscore emphasis', () => {
    expect(parseJournalResponse('- _Worked on:_ underscored').workedOn).toBe('underscored');
  });

  it('returns "(not specified)" for missing bullets rather than throwing', () => {
    const text = '- **Worked on:** only this one';
    const section = parseJournalResponse(text);
    expect(section.workedOn).toBe('only this one');
    expect(section.decided).toBe('(not specified)');
    expect(section.learnedAboutOperator).toBe('(not specified)');
    expect(section.openThreads).toBe('(not specified)');
  });

  it('matches case-insensitively on the label', () => {
    const text = '- **WORKED ON:** loud label';
    expect(parseJournalResponse(text).workedOn).toBe('loud label');
  });

  it('ignores prose around the bullets', () => {
    const text = [
      'Here is the entry:',
      '',
      '- **Worked on:** wrapped in prose',
      '- **Decided:** model added preamble',
      '',
      'Hope this helps!',
    ].join('\n');
    const section = parseJournalResponse(text);
    expect(section.workedOn).toBe('wrapped in prose');
    expect(section.decided).toBe('model added preamble');
  });
});
