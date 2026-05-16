import { describe, expect, it } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

import { renderChatNote } from '../../src/chats/ChatNoteWriter';

function turn(role: 'user' | 'assistant', text: string): MessageParam {
  return { role, content: text };
}

describe('renderChatNote', () => {
  it('renders a Q&A body with H2 headers per turn', () => {
    const result = renderChatNote(
      [turn('user', 'What is Q3 strategy?'), turn('assistant', 'See [[30-Projects/q3.md]].')],
      { startedAt: 1700000000000, endedAt: 1700000060000, mode: 'chat' },
    );
    expect(result.content).toContain('## Operator');
    expect(result.content).toContain('What is Q3 strategy?');
    expect(result.content).toContain('## Sagittarius');
    expect(result.content).toContain('See [[30-Projects/q3.md]].');
  });

  it('derives slug + title from the first user message', () => {
    const result = renderChatNote(
      [turn('user', 'What is Q3 strategy?'), turn('assistant', 'Reply.')],
      { startedAt: 0, endedAt: 0, mode: 'chat' },
    );
    expect(result.slug).toBe('what-is-q3-strategy');
    expect(result.title).toBe('What is Q3 strategy?');
  });

  it('emits frontmatter with type, session_id, dates, mode, turn_count', () => {
    const result = renderChatNote(
      [turn('user', 'q'), turn('assistant', 'a')],
      { startedAt: 1700000000000, endedAt: 1700000060000, mode: 'vault-qa' },
    );
    expect(result.content).toMatch(/^---\n/);
    expect(result.content).toContain("type: 'chat'");
    expect(result.content).toContain("mode: 'vault-qa'");
    expect(result.content).toContain('turn_count: 1');
    expect(result.content).toContain('started_at: 1700000000');
    expect(result.content).toContain('ended_at: 1700000060');
    expect(result.content).toMatch(/session_id: '[0-9a-f]{4}-/);
  });

  it('extracts cited_chunks from assistant `[[]]` markers (D3 + D4)', () => {
    const result = renderChatNote(
      [
        turn('user', 'q'),
        turn('assistant', 'See [[a.md]] and [[b.md#header]] for details.'),
      ],
      { startedAt: 0, endedAt: 0, mode: 'chat' },
    );
    expect(result.citedNotePaths).toEqual(['a.md', 'b.md']);
    expect(result.content).toContain("- { note: 'a.md', chunk: null, score: 0 }");
    expect(result.content).toContain("- { note: 'b.md', chunk: null, score: 0 }");
  });

  it('emits empty cited_chunks array when no citations exist', () => {
    const result = renderChatNote(
      [turn('user', 'q'), turn('assistant', 'plain prose')],
      { startedAt: 0, endedAt: 0, mode: 'chat' },
    );
    expect(result.citedNotePaths).toEqual([]);
    expect(result.content).toContain('cited_chunks: []');
  });

  it('includes optional tokens/cost when metadata provides them', () => {
    const result = renderChatNote(
      [turn('user', 'q'), turn('assistant', 'a')],
      {
        startedAt: 0,
        endedAt: 0,
        mode: 'chat',
        tokensIn: 1234,
        tokensOut: 567,
        costUsd: 0.0089,
      },
    );
    expect(result.content).toContain('tokens_in: 1234');
    expect(result.content).toContain('tokens_out: 567');
    expect(result.content).toContain('cost_usd: 0.0089');
  });

  it('omits token/cost fields when metadata does not provide them', () => {
    const result = renderChatNote(
      [turn('user', 'q'), turn('assistant', 'a')],
      { startedAt: 0, endedAt: 0, mode: 'chat' },
    );
    expect(result.content).not.toContain('tokens_in:');
    expect(result.content).not.toContain('cost_usd:');
  });

  it('throws on empty history', () => {
    expect(() =>
      renderChatNote([], { startedAt: 0, endedAt: 0, mode: 'chat' }),
    ).toThrow(/empty/);
  });

  it('handles a trailing user message without a response', () => {
    const result = renderChatNote(
      [turn('user', 'first'), turn('assistant', 'reply'), turn('user', 'cliffhanger')],
      { startedAt: 0, endedAt: 0, mode: 'chat' },
    );
    expect(result.turnCount).toBe(1); // only one (user, assistant) pair completed
    expect(result.content).toContain('cliffhanger');
  });

  it('handles complex content blocks (Anthropic SDK array form)', () => {
    const history: MessageParam[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reply with [[link.md]]', citations: [] },
        ],
      },
    ];
    const result = renderChatNote(history, { startedAt: 0, endedAt: 0, mode: 'chat' });
    expect(result.content).toContain('reply with [[link.md]]');
    expect(result.citedNotePaths).toEqual(['link.md']);
  });
});
