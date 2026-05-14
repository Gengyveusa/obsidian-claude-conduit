import { describe, expect, it } from 'vitest';

import {
  AnthropicDuplicateLlmJudge,
  AnthropicTagNormalizeLlmJudge,
  extractText,
} from '../../src/curator/AnthropicLlmJudge';
import type { MessagesAPI } from '../../src/agent/ConduitAgent';

interface RecordedCreate {
  model: string;
  maxTokens: number;
  text: string;
}

function fakeMessages(responses: string[]): { api: MessagesAPI; calls: RecordedCreate[] } {
  const calls: RecordedCreate[] = [];
  let i = 0;
  const api: MessagesAPI = {
    create: (params) => {
      const text = responses[i] ?? '';
      i += 1;
      const userText = Array.isArray(params.messages[0].content)
        ? ''
        : String(params.messages[0].content);
      calls.push({
        model: String(params.model),
        maxTokens: params.max_tokens,
        text: userText,
      });
      return Promise.resolve({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: String(params.model),
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'text', text }],
        // The full Message type has more fields; we only use `content`.
      } as unknown as Awaited<ReturnType<MessagesAPI['create']>>);
    },
  };
  return { api, calls };
}

function throwingMessages(): MessagesAPI {
  return {
    create: () => Promise.reject(new Error('rate limit')),
  };
}

describe('extractText', () => {
  it('returns the first text block text', () => {
    expect(extractText({ content: [{ type: 'text', text: 'hi' }] })).toBe('hi');
  });

  it('returns empty when no text block is present', () => {
    expect(extractText({ content: [{ type: 'tool_use' }] })).toBe('');
  });

  it('skips non-text blocks to find the first text', () => {
    expect(
      extractText({
        content: [{ type: 'tool_use' }, { type: 'text', text: 'after' }],
      }),
    ).toBe('after');
  });
});

describe('AnthropicDuplicateLlmJudge', () => {
  it('returns true when the model says YES', async () => {
    const { api } = fakeMessages(['YES']);
    const judge = new AnthropicDuplicateLlmJudge(api);
    const out = await judge.judge(
      { path: 'a.md', content: 'about cats' },
      { path: 'b.md', content: 'about cats too' },
    );
    expect(out).toBe(true);
  });

  it('returns false when the model says NO', async () => {
    const { api } = fakeMessages(['NO']);
    const judge = new AnthropicDuplicateLlmJudge(api);
    expect(
      await judge.judge({ path: 'a.md', content: 'x' }, { path: 'b.md', content: 'y' }),
    ).toBe(false);
  });

  it('accepts mixed-case YES variants', async () => {
    const { api } = fakeMessages(['Yes, these are duplicates']);
    const judge = new AnthropicDuplicateLlmJudge(api);
    expect(
      await judge.judge({ path: 'a.md', content: 'x' }, { path: 'b.md', content: 'y' }),
    ).toBe(true);
  });

  it('returns false on empty or ambiguous responses', async () => {
    const { api } = fakeMessages(['', 'maybe', 'NOPE']);
    const judge = new AnthropicDuplicateLlmJudge(api);
    expect(
      await judge.judge({ path: '1.md', content: 'x' }, { path: '2.md', content: 'y' }),
    ).toBe(false);
    expect(
      await judge.judge({ path: '3.md', content: 'x' }, { path: '4.md', content: 'y' }),
    ).toBe(false);
    expect(
      await judge.judge({ path: '5.md', content: 'x' }, { path: '6.md', content: 'y' }),
    ).toBe(false);
  });

  it('increments callCount per invocation', async () => {
    const { api } = fakeMessages(['YES', 'NO']);
    const judge = new AnthropicDuplicateLlmJudge(api);
    expect(judge.callCount).toBe(0);
    await judge.judge({ path: 'a.md', content: '' }, { path: 'b.md', content: '' });
    expect(judge.callCount).toBe(1);
    await judge.judge({ path: 'a.md', content: '' }, { path: 'b.md', content: '' });
    expect(judge.callCount).toBe(2);
  });

  it('counts the call even when the SDK rejects', async () => {
    const judge = new AnthropicDuplicateLlmJudge(throwingMessages());
    await expect(
      judge.judge({ path: 'a.md', content: '' }, { path: 'b.md', content: '' }),
    ).rejects.toThrow(/rate limit/);
    expect(judge.callCount).toBe(1);
  });

  it('uses haiku by default and caps tokens aggressively', async () => {
    const { api, calls } = fakeMessages(['NO']);
    const judge = new AnthropicDuplicateLlmJudge(api);
    await judge.judge({ path: 'a.md', content: 'x' }, { path: 'b.md', content: 'y' });
    expect(calls[0].model).toBe('claude-haiku-4-5-20251001');
    expect(calls[0].maxTokens).toBeLessThanOrEqual(64);
  });
});

describe('AnthropicTagNormalizeLlmJudge', () => {
  it('returns the canonical when picked from cluster', async () => {
    const { api } = fakeMessages(['project']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    expect(await judge.judge(['project', 'projects', 'proj'])).toBe('project');
  });

  it('lowercases the canonical', async () => {
    const { api } = fakeMessages(['Project']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    expect(await judge.judge(['project', 'Project'])).toBe('project');
  });

  it('strips a leading #', async () => {
    const { api } = fakeMessages(['#project']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    expect(await judge.judge(['project', 'projects'])).toBe('project');
  });

  it('returns null when the model says NO', async () => {
    const { api } = fakeMessages(['NO']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    expect(await judge.judge(['cat', 'dog'])).toBeNull();
  });

  it('returns null when the model picks a tag outside the cluster (hallucination guard)', async () => {
    const { api } = fakeMessages(['banana']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    expect(await judge.judge(['project', 'projects'])).toBeNull();
  });

  it('returns null on empty response', async () => {
    const { api } = fakeMessages(['']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    expect(await judge.judge(['a', 'b'])).toBeNull();
  });

  it('increments callCount per invocation', async () => {
    const { api } = fakeMessages(['NO', 'project']);
    const judge = new AnthropicTagNormalizeLlmJudge(api);
    await judge.judge(['a', 'b']);
    await judge.judge(['project', 'projects']);
    expect(judge.callCount).toBe(2);
  });
});
