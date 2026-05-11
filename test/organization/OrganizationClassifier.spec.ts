import type { Message, MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessagesAPI } from '../../src/agent/ConduitAgent';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  OrganizationClassifier,
  parseClassifierResponse,
} from '../../src/organization/OrganizationClassifier';
import type { RetrievalLayer } from '../../src/retrieval/RetrievalLayer';
import type { QueryResult } from '../../src/retrieval/types';

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

/** Build a fake RetrievalLayer that returns the given hits for any query. */
function fakeRetrieval(hits: QueryResult[]): RetrievalLayer {
  return {
    queryUnified: vi.fn(() => Promise.resolve(hits)),
  } as unknown as RetrievalLayer;
}

/** Build a Message envelope around a JSON text response. */
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

/** Build a MessagesAPI stub that returns the given Message regardless of input. */
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

const HIT = (path: string, score: number): QueryResult => ({
  path,
  chunk: 0,
  title: null,
  source: null,
  doctrine: null,
  score,
  text: 'snippet',
});

describe('parseClassifierResponse', () => {
  it('parses a clean JSON response', () => {
    const out = parseClassifierResponse(
      '{"folder": "70-Memory/notes", "confidence": 0.84, "reason": "matches similar notes"}',
    );
    expect(out).toEqual({
      folder: '70-Memory/notes',
      confidence: 0.84,
      reason: 'matches similar notes',
    });
  });

  it('strips a markdown code fence (json) wrapper', () => {
    const out = parseClassifierResponse(
      '```json\n{"folder": "x", "confidence": 0.5, "reason": "y"}\n```',
    );
    expect(out.folder).toBe('x');
  });

  it('strips a plain triple-backtick wrapper', () => {
    const out = parseClassifierResponse(
      '```\n{"folder": "x", "confidence": 0.5, "reason": "y"}\n```',
    );
    expect(out.folder).toBe('x');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseClassifierResponse('not json')).toThrow(/not valid JSON/);
  });

  it('throws when missing folder', () => {
    expect(() =>
      parseClassifierResponse('{"confidence": 0.5, "reason": "x"}'),
    ).toThrow(/missing string "folder"/);
  });

  it('throws on confidence out of [0, 1]', () => {
    expect(() =>
      parseClassifierResponse('{"folder": "x", "confidence": 1.5, "reason": "y"}'),
    ).toThrow(/in \[0, 1\]/);
  });

  it('throws on non-string reason', () => {
    expect(() =>
      parseClassifierResponse('{"folder": "x", "confidence": 0.5, "reason": null}'),
    ).toThrow(/missing string "reason"/);
  });

  it('throws on top-level array', () => {
    expect(() => parseClassifierResponse('[]')).toThrow(/JSON object/);
  });
});

describe('OrganizationClassifier', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
    adapter.files.set('10-Inbox/foo.md', 'Some inbox note about meetings.');
  });

  it('throws when the note does not exist', async () => {
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages: fakeMessagesApi(makeMessage('{"folder":"x","confidence":1,"reason":"y"}')),
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await expect(cls.classifyForRoute('missing.md')).rejects.toThrow(/does not exist/);
  });

  it('produces a RouteSuggestion when the model returns a folder', async () => {
    const messages = fakeMessagesApi(
      makeMessage('{"folder": "70-Memory/notes", "confidence": 0.82, "reason": "similar to other meeting notes"}'),
    );
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([
        HIT('70-Memory/notes/a.md', 0.81),
        HIT('70-Memory/notes/b.md', 0.78),
      ]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
      now: () => 1700_000_000_000,
      randId: () => 'abcdef',
    });

    const result = await cls.classifyForRoute('10-Inbox/foo.md');
    expect(result.suggestion).toEqual({
      kind: 'route',
      id: '1700000000000-abcdef',
      createdAt: 1_700_000_000,
      notePath: '10-Inbox/foo.md',
      proposedFolder: '70-Memory/notes',
      reason: 'similar to other meeting notes',
      confidence: 0.82,
    });
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(30);
  });

  it('strips a trailing slash from the proposed folder', async () => {
    const messages = fakeMessagesApi(
      makeMessage('{"folder": "70-Memory/notes/", "confidence": 0.7, "reason": "x"}'),
    );
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    const result = await cls.classifyForRoute('10-Inbox/foo.md');
    expect(result.suggestion?.proposedFolder).toBe('70-Memory/notes');
  });

  it('returns suggestion: null when the model says KEEP', async () => {
    const messages = fakeMessagesApi(
      makeMessage('{"folder": "KEEP", "confidence": 0.9, "reason": "already in a sensible folder"}'),
    );
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    const result = await cls.classifyForRoute('10-Inbox/foo.md');
    expect(result.suggestion).toBeNull();
    expect(result.tokensOut).toBe(30);
  });

  it('passes the configured model to the messages API', async () => {
    const messages = fakeMessagesApi(makeMessage('{"folder":"KEEP","confidence":1,"reason":"x"}'));
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-haiku-4-5-20251001',
    });
    await cls.classifyForRoute('10-Inbox/foo.md');
    expect(messages.calls).toHaveLength(1);
    expect(messages.calls[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('embeds the constitution into the system prompt', async () => {
    const messages = fakeMessagesApi(makeMessage('{"folder":"KEEP","confidence":1,"reason":"x"}'));
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'NEVER auto-respond to a FortressFlow reply.',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForRoute('10-Inbox/foo.md');
    const system = messages.calls[0].system as string;
    expect(system).toMatch(/FortressFlow reply/);
  });

  it('filters the note itself out of the retrieval hits before passing to the model', async () => {
    const messages = fakeMessagesApi(makeMessage('{"folder":"KEEP","confidence":1,"reason":"x"}'));
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([
        HIT('10-Inbox/foo.md', 0.99), // self-hit, must be filtered
        HIT('70-Memory/notes/other.md', 0.7),
      ]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForRoute('10-Inbox/foo.md');
    const userMsg = messages.calls[0].messages[0].content as string;
    expect(userMsg).not.toContain('10-Inbox/foo.md   (folder:');
    expect(userMsg).toContain('70-Memory/notes/other.md');
  });

  it('describes empty hits as "no similar notes" in the prompt', async () => {
    const messages = fakeMessagesApi(makeMessage('{"folder":"KEEP","confidence":1,"reason":"x"}'));
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForRoute('10-Inbox/foo.md');
    const userMsg = messages.calls[0].messages[0].content as string;
    expect(userMsg).toMatch(/No similar existing notes found/);
  });

  it('truncates the note body to first 500 chars in the prompt', async () => {
    const longBody = 'A'.repeat(2000);
    adapter.files.set('10-Inbox/long.md', longBody);

    const messages = fakeMessagesApi(makeMessage('{"folder":"KEEP","confidence":1,"reason":"x"}'));
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await cls.classifyForRoute('10-Inbox/long.md');
    const userMsg = messages.calls[0].messages[0].content as string;
    // Should contain a 500-A run, NOT a 2000-A run
    expect(userMsg).toContain('A'.repeat(500));
    expect(userMsg).not.toContain('A'.repeat(501));
  });

  it('propagates a malformed-JSON model response as a clear error', async () => {
    const messages = fakeMessagesApi(makeMessage('not even json'));
    const cls = new OrganizationClassifier({
      adapter,
      retrieval: fakeRetrieval([]),
      messages,
      constitution: 'CONSTITUTION',
      classifierModel: 'claude-sonnet-4-6',
    });
    await expect(cls.classifyForRoute('10-Inbox/foo.md')).rejects.toThrow(/not valid JSON/);
  });
});
