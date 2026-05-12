import type { Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MessagesAPI } from '../../src/agent/ConduitAgent';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  MocAddClassifier,
  parseMocAddResponse,
} from '../../src/organization/MocAddClassifier';
import type { MocCandidate } from '../../src/organization/MocDiscovery';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();

  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const v = this.files.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
  }
  write(): Promise<void> {
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(): Promise<void> {
    throw new Error('unused');
  }
  delete(): Promise<void> {
    throw new Error('unused');
  }
  renameFile(): Promise<void> {
    throw new Error('unused');
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
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

function makeMessage(jsonText: string, tokensIn = 100, tokensOut = 30): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: jsonText, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: tokensIn,
      output_tokens: tokensOut,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
  } as unknown as Message;
}

function fakeMessagesApi(message: Message): MessagesAPI & { calls: MessageCreateParams[] } {
  const calls: MessageCreateParams[] = [];
  return {
    calls,
    create: (params: MessageCreateParams) => {
      calls.push(params);
      return Promise.resolve(message);
    },
  };
}

const CANDIDATE = (
  path: string,
  basename: string,
  firstHeading: string | null = null,
  wikilinkBulletCount = 5,
): MocCandidate => ({
  path,
  basename,
  firstHeading,
  wikilinkBulletCount,
  metrics: {
    looksLikeMoc: true,
    firstHeading,
    wikilinkBulletCount,
    bodyLineCount: wikilinkBulletCount + 1,
    linkDensity: 1,
  },
});

describe('parseMocAddResponse', () => {
  it('parses a minimal valid response', () => {
    const out = parseMocAddResponse(
      '{"mocPath": "22-Decisions/00_Index.md", "confidence": 0.8, "reason": "fits the decisions theme"}',
    );
    expect(out).toEqual({
      mocPath: '22-Decisions/00_Index.md',
      confidence: 0.8,
      reason: 'fits the decisions theme',
    });
  });

  it('parses an anchor when provided', () => {
    const out = parseMocAddResponse(
      '{"mocPath": "x.md", "confidence": 0.7, "reason": "y", "anchor": "## Recent"}',
    );
    expect(out.anchor).toBe('## Recent');
  });

  it('omits anchor when empty string', () => {
    const out = parseMocAddResponse(
      '{"mocPath": "x.md", "confidence": 0.7, "reason": "y", "anchor": ""}',
    );
    expect(out.anchor).toBeUndefined();
  });

  it('strips markdown json fences', () => {
    const out = parseMocAddResponse(
      '```json\n{"mocPath": "x.md", "confidence": 0.5, "reason": "y"}\n```',
    );
    expect(out.mocPath).toBe('x.md');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseMocAddResponse('not json')).toThrow(/not valid JSON/);
  });

  it('throws on missing mocPath', () => {
    expect(() =>
      parseMocAddResponse('{"confidence": 0.5, "reason": "x"}'),
    ).toThrow(/missing string "mocPath"/);
  });

  it('throws on confidence outside [0, 1]', () => {
    expect(() =>
      parseMocAddResponse('{"mocPath": "x.md", "confidence": 1.5, "reason": "y"}'),
    ).toThrow(/in \[0, 1\]/);
  });

  it('throws on non-string reason', () => {
    expect(() =>
      parseMocAddResponse('{"mocPath": "x.md", "confidence": 0.5, "reason": null}'),
    ).toThrow(/missing string "reason"/);
  });

  it('throws on top-level array', () => {
    expect(() => parseMocAddResponse('[]')).toThrow(/JSON object/);
  });
});

describe('MocAddClassifier', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
    adapter.files.set('10-Inbox/foo.md', 'A new note about an architectural decision.');
  });

  it('returns suggestion: null without an LLM call when candidates are empty', async () => {
    const messages = fakeMessagesApi(makeMessage('{"mocPath":"NONE","confidence":1,"reason":"x"}'));
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    const result = await cls.classifyForMocAdd('10-Inbox/foo.md', []);
    expect(result.suggestion).toBeNull();
    expect(messages.calls).toHaveLength(0); // no LLM call — cost saver
    expect(result.tokensIn).toBe(0);
  });

  it('throws when the note does not exist', async () => {
    const cls = new MocAddClassifier({
      adapter,
      messages: fakeMessagesApi(makeMessage('{"mocPath":"NONE","confidence":1,"reason":"x"}')),
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await expect(
      cls.classifyForMocAdd('missing.md', [CANDIDATE('m.md', 'm')]),
    ).rejects.toThrow(/does not exist/);
  });

  it('returns null when the model says NONE', async () => {
    const messages = fakeMessagesApi(
      makeMessage(
        '{"mocPath": "NONE", "confidence": 0.9, "reason": "not a strong fit for any candidate"}',
      ),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    const result = await cls.classifyForMocAdd('10-Inbox/foo.md', [
      CANDIDATE('22-Decisions/00_Index.md', '00_Index', 'Decisions'),
    ]);
    expect(result.suggestion).toBeNull();
    expect(result.tokensIn).toBe(100);
  });

  it('returns a MocAddSuggestion when the model picks a candidate', async () => {
    const messages = fakeMessagesApi(
      makeMessage(
        '{"mocPath": "22-Decisions/00_Index.md", "confidence": 0.85, "reason": "matches the Decisions theme"}',
      ),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
      now: () => 1700000000000,
      randId: () => 'abcdef',
    });
    const result = await cls.classifyForMocAdd('10-Inbox/foo.md', [
      CANDIDATE('22-Decisions/00_Index.md', '00_Index', 'Decisions'),
    ]);
    expect(result.suggestion).toEqual({
      kind: 'moc-add',
      id: '1700000000000-abcdef',
      createdAt: 1700000000,
      notePath: '10-Inbox/foo.md',
      mocPath: '22-Decisions/00_Index.md',
      reason: 'matches the Decisions theme',
      confidence: 0.85,
    });
  });

  it('includes anchor in the suggestion when the model provides one', async () => {
    const messages = fakeMessagesApi(
      makeMessage(
        '{"mocPath": "22-Decisions/00_Index.md", "confidence": 0.85, "reason": "matches", "anchor": "## Recent"}',
      ),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    const result = await cls.classifyForMocAdd('10-Inbox/foo.md', [
      CANDIDATE('22-Decisions/00_Index.md', '00_Index'),
    ]);
    expect(result.suggestion?.mocAnchor).toBe('## Recent');
  });

  it('drops the suggestion when mocPath does not match any candidate (hallucination guard)', async () => {
    const messages = fakeMessagesApi(
      makeMessage(
        '{"mocPath": "made-up/path.md", "confidence": 0.9, "reason": "x"}',
      ),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    const result = await cls.classifyForMocAdd('10-Inbox/foo.md', [
      CANDIDATE('22-Decisions/real.md', 'real'),
    ]);
    expect(result.suggestion).toBeNull();
  });

  it('passes the configured model to the messages API', async () => {
    const messages = fakeMessagesApi(
      makeMessage('{"mocPath":"NONE","confidence":1,"reason":"x"}'),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-haiku-4-5-20251001',
    });
    await cls.classifyForMocAdd('10-Inbox/foo.md', [CANDIDATE('x.md', 'x')]);
    expect(messages.calls[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('embeds the constitution into the system prompt', async () => {
    const messages = fakeMessagesApi(
      makeMessage('{"mocPath":"NONE","confidence":1,"reason":"x"}'),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'NEVER auto-respond to a FortressFlow reply.',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForMocAdd('10-Inbox/foo.md', [CANDIDATE('x.md', 'x')]);
    const system = messages.calls[0].system as string;
    expect(system).toMatch(/FortressFlow reply/);
  });

  it('lists candidates in the user message with title + entries', async () => {
    const messages = fakeMessagesApi(
      makeMessage('{"mocPath":"NONE","confidence":1,"reason":"x"}'),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForMocAdd('10-Inbox/foo.md', [
      CANDIDATE('22-Decisions/00_Index.md', '00_Index', 'Decisions', 14),
      CANDIDATE('30-Gengyve-GTM/MOC.md', 'MOC', null, 8),
    ]);
    const userMsg = messages.calls[0].messages[0].content as string;
    expect(userMsg).toContain('22-Decisions/00_Index.md');
    expect(userMsg).toContain('title: "Decisions"');
    expect(userMsg).toContain('entries: 14');
    expect(userMsg).toContain('30-Gengyve-GTM/MOC.md');
    // No firstHeading → falls back to basename
    expect(userMsg).toContain('title: "MOC"');
  });

  it('truncates the note body to first 500 chars', async () => {
    adapter.files.set('10-Inbox/long.md', 'A'.repeat(2000));
    const messages = fakeMessagesApi(
      makeMessage('{"mocPath":"NONE","confidence":1,"reason":"x"}'),
    );
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForMocAdd('10-Inbox/long.md', [CANDIDATE('x.md', 'x')]);
    const userMsg = messages.calls[0].messages[0].content as string;
    expect(userMsg).toContain('A'.repeat(500));
    expect(userMsg).not.toContain('A'.repeat(501));
  });

  it('propagates malformed-JSON model response as a clear error', async () => {
    const messages = fakeMessagesApi(makeMessage('not json'));
    const cls = new MocAddClassifier({
      adapter,
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await expect(
      cls.classifyForMocAdd('10-Inbox/foo.md', [CANDIDATE('x.md', 'x')]),
    ).rejects.toThrow(/not valid JSON/);
  });
});
