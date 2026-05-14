import { describe, expect, it } from 'vitest';
import type {
  Message,
  MessageCreateParams,
} from '@anthropic-ai/sdk/resources/messages';

import type { BudgetTracker } from '../../src/budget/BudgetTracker';
import {
  AnthropicDraftingEngine,
  buildSystemPrompt,
  buildUserMessage,
  type DraftingEngineSettings,
  type DraftingMessagesAPI,
} from '../../src/drafts/DraftingEngine';
import type { RetrievalLayer } from '../../src/retrieval/RetrievalLayer';
import type { QueryResult } from '../../src/retrieval/types';

const DEFAULT_SETTINGS: DraftingEngineSettings = {
  draftingModel: 'claude-opus-4-7',
  citationPolicy: 'marked',
  draftsDefaultDestination: '10-Inbox',
  retrievalK: 4,
};

class FakeRetrieval {
  constructor(private readonly results: QueryResult[]) {}
  queryUnified(): Promise<QueryResult[]> {
    return Promise.resolve(this.results);
  }
}

class FakeBudget {
  reservations: number[] = [];
  commits: { tokensIn: number; tokensOut: number; costUsd: number }[] = [];
  assertAvailable(reserved: number): void {
    this.reservations.push(reserved);
  }
  async commit(usage: { tokensIn: number; tokensOut: number; costUsd: number }): Promise<void> {
    this.commits.push(usage);
    return Promise.resolve();
  }
}

class ScriptedMessages implements DraftingMessagesAPI {
  private readonly responses: Message[];
  readonly received: MessageCreateParams[] = [];
  constructor(responses: Message[]) {
    this.responses = [...responses];
  }
  create(params: MessageCreateParams): Promise<Message> {
    this.received.push(params);
    const next = this.responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error('ScriptedMessages: ran out of scripted responses'));
    }
    return Promise.resolve(next);
  }
}

function fakeChunk(path: string, idx: number, score: number, text: string): QueryResult {
  return { path, chunk: idx, title: null, source: null, doctrine: null, score, text };
}

function fakeMessage(body: string, input = 500, output = 800): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: body, citations: [] }],
    model: 'claude-opus-4-7',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: 'standard',
      inference_geo: null,
    },
  } as unknown as Message;
}

function buildHarness(
  responses: Message[],
  chunks: QueryResult[],
  overrides: Partial<DraftingEngineSettings> = {},
): {
  engine: AnthropicDraftingEngine;
  messages: ScriptedMessages;
  budget: FakeBudget;
} {
  const messages = new ScriptedMessages(responses);
  const budget = new FakeBudget();
  const retrieval = new FakeRetrieval(chunks) as unknown as RetrievalLayer;
  const settings: DraftingEngineSettings = { ...DEFAULT_SETTINGS, ...overrides };
  const engine = new AnthropicDraftingEngine({
    messages,
    retrieval,
    budget: budget as unknown as BudgetTracker,
    settings: () => settings,
    clock: () => 1_700_000_000,
    logger: { warn: () => {} },
  });
  return { engine, messages, budget };
}

describe('AnthropicDraftingEngine.generate', () => {
  it('produces a Draft from retrieved chunks + a passing first attempt', async () => {
    const chunks = [
      fakeChunk('10-Inbox/sync.md', 0, 0.88, 'The team decided to revise Q3.'),
      fakeChunk('10-Inbox/notes.md', 1, 0.71, 'Background context.'),
    ];
    const body =
      'The Q3 plan was revised in the sync [[10-Inbox/sync.md]].\n\n' +
      '<!-- uncited -->\nSynthesizing across the notes.\n<!-- /uncited -->';
    const { engine } = buildHarness([fakeMessage(body)], chunks);

    const draft = await engine.generate({ topic: 'Q3 revision summary' });

    expect(draft.path).toBe('_drafts/10-Inbox/q3-revision-summary.md');
    expect(draft.topic).toBe('Q3 revision summary');
    expect(draft.body).toBe(body);
    expect(draft.draftingModel).toBe('claude-opus-4-7');
    expect(draft.generatedAt).toBe(1_700_000_000);
    expect(draft.strictFallback).toBe(false);
    expect(draft.citedChunks).toHaveLength(1);
    expect(draft.citedChunks[0].notePath).toBe('10-Inbox/sync.md');
  });

  it('throws when retrieval returns no chunks', async () => {
    const { engine } = buildHarness([], []);
    await expect(engine.generate({ topic: 'nothing' })).rejects.toThrow(
      /no vault chunks matched/,
    );
  });

  it('retries once when the first attempt fails the marked policy', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'context')];
    // First attempt: an uncited paragraph that isn't marked → fails.
    const bad = 'Cited prose [[a.md]].\n\nUnmarked synthesis.';
    // Second attempt: clean.
    const good =
      'Cited prose [[a.md]].\n\n<!-- uncited -->\nNow marked.\n<!-- /uncited -->';
    const { engine, messages } = buildHarness([fakeMessage(bad), fakeMessage(good)], chunks);

    const draft = await engine.generate({ topic: 't' });
    expect(messages.received).toHaveLength(2);
    expect(draft.strictFallback).toBe(false);
    expect(draft.body).toBe(good);
  });

  it('falls back with strictFallback=true when both attempts violate the policy', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'context')];
    const bad1 = 'Cited [[a.md]].\n\nUnmarked synthesis.';
    const bad2 = 'Cited [[a.md]].\n\nStill unmarked synthesis.';
    const { engine } = buildHarness([fakeMessage(bad1), fakeMessage(bad2)], chunks);

    const draft = await engine.generate({ topic: 't' });
    expect(draft.strictFallback).toBe(true);
    expect(draft.body).toBe(bad2);
  });

  it('does not retry under the free policy', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'context')];
    const body = 'Anything goes.';
    const { engine, messages } = buildHarness([fakeMessage(body)], chunks, {
      citationPolicy: 'free',
    });

    const draft = await engine.generate({ topic: 't' });
    expect(messages.received).toHaveLength(1);
    expect(draft.strictFallback).toBe(false);
    expect(draft.body).toBe('Anything goes.');
  });

  it('reserves the output-token budget before each call', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'x')];
    const { engine, budget } = buildHarness([fakeMessage('Cited [[a.md]].')], chunks);
    await engine.generate({ topic: 't' });
    expect(budget.reservations).toHaveLength(1);
    expect(budget.reservations[0]).toBeGreaterThan(0);
  });

  it('commits actual usage to the budget after the call', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'x')];
    const { engine, budget } = buildHarness(
      [fakeMessage('Cited [[a.md]].', 1234, 567)],
      chunks,
    );
    await engine.generate({ topic: 't' });
    expect(budget.commits).toHaveLength(1);
    expect(budget.commits[0].tokensIn).toBe(1234);
    expect(budget.commits[0].tokensOut).toBe(567);
    // Opus pricing: 15/M in, 75/M out.
    const expected = (1234 / 1_000_000) * 15 + (567 / 1_000_000) * 75;
    expect(budget.commits[0].costUsd).toBeCloseTo(expected, 6);
  });

  it('uses the destinationFolder from spec when provided, else from settings', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'x')];
    const body = '<!-- uncited -->\nx\n<!-- /uncited -->';
    const { engine } = buildHarness([fakeMessage(body)], chunks);
    const draftA = await engine.generate({ topic: 't' });
    expect(draftA.path).toBe('_drafts/10-Inbox/t.md');

    const { engine: engineB } = buildHarness([fakeMessage(body)], chunks);
    const draftB = await engineB.generate({
      topic: 't',
      destinationFolder: '30-Projects',
    });
    expect(draftB.path).toBe('_drafts/30-Projects/t.md');
  });

  it('passes the drafting model AND a non-empty system prompt to messages.create', async () => {
    const chunks = [fakeChunk('a.md', 0, 0.9, 'x')];
    const { engine, messages } = buildHarness(
      [fakeMessage('Cited [[a.md]].')],
      chunks,
    );
    await engine.generate({ topic: 't' });
    const call = messages.received[0];
    expect(call.model).toBe('claude-opus-4-7');
    expect(typeof call.system).toBe('string');
    expect((call.system as string).length).toBeGreaterThan(100);
  });
});

describe('buildSystemPrompt', () => {
  it("includes the strict-policy instructions when policy is 'strict'", () => {
    const prompt = buildSystemPrompt('strict');
    expect(prompt).toMatch(/Every paragraph must include at least one wikilink citation/);
  });

  it("includes the marked-policy instructions when policy is 'marked'", () => {
    const prompt = buildSystemPrompt('marked');
    expect(prompt).toMatch(/wrapped[\s\S]+HTML comments/);
  });

  it("includes the free-policy disclaimer when policy is 'free'", () => {
    const prompt = buildSystemPrompt('free');
    expect(prompt).toMatch(/trust trade-off/);
  });

  it('always demands pure markdown output (no preamble)', () => {
    for (const policy of ['strict', 'marked', 'free'] as const) {
      expect(buildSystemPrompt(policy)).toMatch(/Pure markdown body/);
    }
  });
});

describe('buildUserMessage', () => {
  it('includes the topic + every chunk with its path and score', () => {
    const msg = buildUserMessage('Q3', [
      { path: 'a.md', chunk: 0, title: null, source: null, doctrine: null, score: 0.85, text: 'alpha' },
      { path: 'b.md', chunk: 1, title: null, source: null, doctrine: null, score: 0.72, text: 'beta' },
    ]);
    expect(msg).toContain('# Topic');
    expect(msg).toContain('Q3');
    expect(msg).toContain('[[a.md]]');
    expect(msg).toContain('score 0.850');
    expect(msg).toContain('alpha');
    expect(msg).toContain('beta');
    expect(msg).toMatch(/no preamble/);
  });
});
