import { APIError } from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParams,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ConduitAgent,
  estimateCost,
  isOverloaded,
  MAX_STEPS,
  type ConduitAgentDeps,
  type MessagesAPI,
} from '../../src/agent/ConduitAgent';
import { ToolRegistry } from '../../src/agent/ToolRegistry';
import type { ToolDefinition } from '../../src/agent/types';
import type { BudgetTracker } from '../../src/budget/BudgetTracker';
import type {
  ConversationLogger,
  ConversationSession,
  ConversationTurn,
} from '../../src/log/ConversationLogger';
import type { WriteToolContext } from '../../src/writes/WriteToolContext';

// ─── Test doubles ──────────────────────────────────────────────────────────

function makeMessage(opts: {
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: object }>;
  inputTokens?: number;
  outputTokens?: number;
}): Message {
  const content: Message['content'] = [];
  if (opts.text) {
    content.push({
      type: 'text',
      text: opts.text,
      citations: null,
    } as unknown as Message['content'][number]);
  }
  for (const tu of opts.toolUses ?? []) {
    content.push({
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input,
    } as unknown as Message['content'][number]);
  }
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-sonnet-4-6',
    stop_reason: opts.stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 100,
      output_tokens: opts.outputTokens ?? 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as Message;
}

function fakeMessagesApi(responses: Message[] | ((p: MessageCreateParams) => Message)): MessagesAPI {
  if (typeof responses === 'function') {
    return {
      create: (p: MessageCreateParams) => Promise.resolve(responses(p)),
    };
  }
  let i = 0;
  return {
    create: () => {
      const r = responses[i];
      i += 1;
      return Promise.resolve(r);
    },
  };
}

class FakeBudget implements Pick<BudgetTracker, 'assertAvailable' | 'commit' | 'snapshot'> {
  asserts: number[] = [];
  commits: Array<{ tokensIn: number; tokensOut: number; costUsd: number }> = [];
  failNext: 'tokens' | 'dollars' | null = null;

  assertAvailable(reservedOutputTokens: number): void {
    this.asserts.push(reservedOutputTokens);
    if (this.failNext === 'tokens') {
      throw new Error('daily token cap reached');
    }
    if (this.failNext === 'dollars') {
      throw new Error('daily dollar cap reached');
    }
  }

  commit(usage: { tokensIn: number; tokensOut: number; costUsd: number }): Promise<void> {
    this.commits.push(usage);
    return Promise.resolve();
  }

  snapshot() {
    return { day: '2026-05-04', tokens_input: 0, tokens_output: 0, dollars_estimated: 0, tz: 'UTC' };
  }
}

class FakeSession implements Pick<ConversationSession, 'append' | 'filePath'> {
  turns: ConversationTurn[] = [];
  id = 'fake-sess';
  append(turn: ConversationTurn): Promise<void> {
    this.turns.push(turn);
    return Promise.resolve();
  }
  filePath(): string {
    return 'fake/path.md';
  }
}

class FakeLogger implements Pick<ConversationLogger, 'startSession'> {
  sessions: FakeSession[] = [];
  startSession(_model: string): ConversationSession {
    const s = new FakeSession();
    this.sessions.push(s);
    return s as unknown as ConversationSession;
  }
}

/**
 * Minimal WriteToolContext stub. ConduitAgent calls begin() then end()
 * (or abandon() on throw); we just need those methods to exist as no-ops
 * for tests that don't exercise write tools.
 */
function makeNoopCtx(): WriteToolContext {
  const stub = {
    begin: () => {
      /* no-op */
    },
    record: () => {
      throw new Error('FakeCtx.record: no write tools should run in these tests');
    },
    end: () => Promise.resolve(null),
    abandon: () => {
      /* no-op */
    },
    isOpen: () => false,
  };
  return stub as unknown as WriteToolContext;
}

function makeDeps(overrides: Partial<ConduitAgentDeps> = {}): {
  deps: ConduitAgentDeps;
  budget: FakeBudget;
  logger: FakeLogger;
  tools: ToolRegistry;
} {
  const tools = new ToolRegistry();
  const budget = new FakeBudget();
  const logger = new FakeLogger();
  const deps: ConduitAgentDeps = {
    messages: { create: () => Promise.reject(new Error('no messages stubbed')) },
    tools,
    budget: budget as unknown as BudgetTracker,
    logger: logger as unknown as ConversationLogger,
    systemPromptParts: { constitution: 'CONSTITUTION', hangarVoice: 'HANGAR' },
    ctx: makeNoopCtx(),
    ...overrides,
  };
  return { deps, budget, logger, tools };
}

const settings = {
  defaultModel: 'claude-sonnet-4-6',
  fallbackModel: 'claude-opus-4-7',
  retrievalK: 8,
};

// Helper: register an `echo` tool that returns its input message uppercased.
function registerEcho(tools: ToolRegistry): void {
  const tool: ToolDefinition<{ message: string }, string> = {
    name: 'echo',
    description: 'echoes',
    inputSchema: z.object({ message: z.string() }),
    jsonSchema: { type: 'object', properties: { message: { type: 'string' } } },
    handler: ({ message }) => Promise.resolve(message.toUpperCase()),
  };
  tools.register(tool);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('ConduitAgent', () => {
  it('returns end_turn after a single non-tool turn', async () => {
    const { deps, budget, logger } = makeDeps({
      messages: fakeMessagesApi([
        makeMessage({ stop_reason: 'end_turn', text: 'Hello, vault.', inputTokens: 200, outputTokens: 100 }),
      ]),
    });
    const agent = new ConduitAgent(deps, settings);

    const result = await agent.chat('hi', [], 'chat');
    expect(result.finalText).toBe('Hello, vault.');
    expect(result.steps).toBe(1);
    expect(result.tokensIn).toBe(200);
    expect(result.tokensOut).toBe(100);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(budget.asserts).toEqual([4096]);
    expect(budget.commits).toHaveLength(1);
    expect(logger.sessions).toHaveLength(1);
    expect(logger.sessions[0].turns[0].assistantMessage).toBe('Hello, vault.');
  });

  it('executes tool_use and continues the loop until end_turn', async () => {
    const { deps, tools } = makeDeps({
      messages: fakeMessagesApi([
        makeMessage({
          stop_reason: 'tool_use',
          toolUses: [{ id: 'tu1', name: 'echo', input: { message: 'hi' } }],
        }),
        makeMessage({ stop_reason: 'end_turn', text: 'Done.' }),
      ]),
    });
    registerEcho(tools);
    const agent = new ConduitAgent(deps, settings);

    const result = await agent.chat('q', [], 'chat');
    expect(result.steps).toBe(2);
    expect(result.finalText).toBe('Done.');
  });

  it('hard-caps at MAX_STEPS to prevent runaway tool-use loops', async () => {
    const { deps, tools } = makeDeps({
      messages: fakeMessagesApi(() =>
        makeMessage({
          stop_reason: 'tool_use',
          toolUses: [{ id: 'tu', name: 'echo', input: { message: 'spin' } }],
        }),
      ),
    });
    registerEcho(tools);
    const agent = new ConduitAgent(deps, settings);

    await expect(agent.chat('loop forever', [], 'chat')).rejects.toThrow(
      new RegExp(`exceeded ${MAX_STEPS} tool-use steps`),
    );
  });

  it('falls back to the secondary model on a 503', async () => {
    const overload = new APIError(503, undefined, 'overloaded', new Headers());
    const create = vi
      .fn<(p: MessageCreateParams) => Promise<Message>>()
      .mockImplementationOnce(() => Promise.reject(overload))
      .mockResolvedValueOnce(makeMessage({ stop_reason: 'end_turn', text: 'fallback ok' }));
    const { deps } = makeDeps({ messages: { create } });
    const agent = new ConduitAgent(deps, settings);

    const result = await agent.chat('q', [], 'chat');
    expect(result.finalText).toBe('fallback ok');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].model).toBe(settings.defaultModel);
    expect(create.mock.calls[1][0].model).toBe(settings.fallbackModel);
  });

  it('does NOT fall back on a 400-class error', async () => {
    const badRequest = new APIError(400, undefined, 'bad', new Headers());
    const create = vi
      .fn<(p: MessageCreateParams) => Promise<Message>>()
      .mockRejectedValue(badRequest);
    const { deps } = makeDeps({ messages: { create } });
    const agent = new ConduitAgent(deps, settings);

    await expect(agent.chat('q', [], 'chat')).rejects.toBe(badRequest);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('skips the API call when budget pre-flight throws', async () => {
    const create = vi.fn<(p: MessageCreateParams) => Promise<Message>>();
    const { deps, budget } = makeDeps({ messages: { create } });
    budget.failNext = 'tokens';
    const agent = new ConduitAgent(deps, settings);

    await expect(agent.chat('q', [], 'chat')).rejects.toThrow(/token cap reached/);
    expect(create).not.toHaveBeenCalled();
  });

  it('commits budget after a turn with the actual usage', async () => {
    const { deps, budget } = makeDeps({
      messages: fakeMessagesApi([
        makeMessage({ stop_reason: 'end_turn', text: 'ok', inputTokens: 1000, outputTokens: 500 }),
      ]),
    });
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('q', [], 'chat');
    expect(budget.commits).toHaveLength(1);
    expect(budget.commits[0].tokensIn).toBe(1000);
    expect(budget.commits[0].tokensOut).toBe(500);
    // Sonnet 4.6 = $3 in, $15 out per million.
    expect(budget.commits[0].costUsd).toBeCloseTo((1000 * 3 + 500 * 15) / 1_000_000, 6);
  });

  it('logs a single turn to the conversation logger', async () => {
    const { deps, logger } = makeDeps({
      messages: fakeMessagesApi([makeMessage({ stop_reason: 'end_turn', text: 'reply' })]),
    });
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('the question', [], 'chat');
    expect(logger.sessions).toHaveLength(1);
    expect(logger.sessions[0].turns).toHaveLength(1);
    expect(logger.sessions[0].turns[0]).toMatchObject({
      userMessage: 'the question',
      assistantMessage: 'reply',
      mode: 'chat',
      model: 'claude-sonnet-4-6',
    });
  });

  it('includes pre-retrieved chunks in vault-qa mode but not in chat mode', async () => {
    const captured: MessageCreateParams[] = [];
    const create = (params: MessageCreateParams) => {
      captured.push(params);
      return Promise.resolve(makeMessage({ stop_reason: 'end_turn', text: 'ok' }));
    };

    const retrieval = {
      queryUnified: vi.fn().mockResolvedValue([
        { path: '50-FortressFlow/Pipeline_State.md', chunk: 0, title: null, source: null, doctrine: null, score: 0.91, text: '14/16 SENT', sourceDb: 'self' },
      ]),
    } as unknown as NonNullable<ConduitAgentDeps['retrieval']>;

    // chat mode: no pre-retrieval
    {
      const { deps: baseDeps } = makeDeps({ messages: { create } });
      const deps: ConduitAgentDeps = { ...baseDeps, retrieval };
      const agent = new ConduitAgent(deps, settings);
      await agent.chat('q', [], 'chat');
      const system = captured[0].system;
      expect(JSON.stringify(system)).not.toContain('Pre-retrieved context');
    }

    // vault-qa: pre-retrieval seeded into system prompt
    {
      const { deps: baseDeps } = makeDeps({ messages: { create } });
      const deps: ConduitAgentDeps = { ...baseDeps, retrieval };
      const agent = new ConduitAgent(deps, settings);
      const result = await agent.chat('q', [], 'vault-qa');
      const system = captured[1].system;
      expect(JSON.stringify(system)).toContain('Pre-retrieved context');
      expect(JSON.stringify(system)).toContain('Pipeline_State.md');
      expect(result.citations).toHaveLength(1);
      expect(result.citations[0].path).toBe('50-FortressFlow/Pipeline_State.md');
    }
  });

  it('propagates tool errors as is_error tool_results, not exceptions', async () => {
    const captured: MessageCreateParams[] = [];
    const create = (params: MessageCreateParams) => {
      // Snapshot messages so post-call mutations don't affect what we
      // observe — the agent re-uses the messages array across loop iters.
      captured.push({ ...params, messages: [...params.messages] });
      // First call: ask the tool. Second call: end the turn.
      if (captured.length === 1) {
        return Promise.resolve(
          makeMessage({
            stop_reason: 'tool_use',
            toolUses: [{ id: 'tu1', name: 'broken', input: {} }],
          }),
        );
      }
      return Promise.resolve(makeMessage({ stop_reason: 'end_turn', text: 'recovered' }));
    };

    const { deps, tools } = makeDeps({ messages: { create } });
    tools.register({
      name: 'broken',
      description: 'always throws',
      inputSchema: z.object({}),
      jsonSchema: { type: 'object', properties: {} },
      handler: () => Promise.reject(new Error('boom')),
    });
    const agent = new ConduitAgent(deps, settings);

    const result = await agent.chat('q', [], 'chat');
    expect(result.finalText).toBe('recovered');
    // Second call's messages array should include a tool_result with is_error: true.
    const secondCallMessages = captured[1].messages;
    const last = secondCallMessages[secondCallMessages.length - 1];
    const toolResult = (last.content as Array<{ is_error?: boolean; content: string }>)[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain('boom');
  });

  it('captures search_vault citations when the agent calls that tool', async () => {
    const captured: MessageCreateParams[] = [];
    const create = (params: MessageCreateParams) => {
      captured.push(params);
      if (captured.length === 1) {
        return Promise.resolve(
          makeMessage({
            stop_reason: 'tool_use',
            toolUses: [{ id: 'sv1', name: 'search_vault', input: { query: 'x' } }],
          }),
        );
      }
      return Promise.resolve(makeMessage({ stop_reason: 'end_turn', text: 'done' }));
    };
    const { deps, tools } = makeDeps({ messages: { create } });
    tools.register({
      name: 'search_vault',
      description: 'fake search',
      inputSchema: z.object({ query: z.string() }),
      jsonSchema: { type: 'object', properties: { query: { type: 'string' } } },
      handler: () =>
        Promise.resolve([
          { path: 'a.md', chunk: 0, score: 0.9, text: 'snippet-a' },
          { path: 'b.md', chunk: 1, score: 0.8, text: 'snippet-b' },
        ]),
    });
    const agent = new ConduitAgent(deps, settings);
    const result = await agent.chat('q', [], 'chat');
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]).toEqual({
      path: 'a.md',
      chunkIndex: 0,
      score: 0.9,
      snippet: 'snippet-a',
    });
  });

  it('records toolsUsed + notesReferenced for non-search_vault tools (v0.1.1)', async () => {
    const create = (() => {
      let n = 0;
      return (_p: MessageCreateParams): Promise<Message> => {
        n++;
        if (n === 1) {
          return Promise.resolve(
            makeMessage({
              stop_reason: 'tool_use',
              toolUses: [{ id: 'rn1', name: 'read_note', input: { path: 'a.md' } }],
            }),
          );
        }
        if (n === 2) {
          return Promise.resolve(
            makeMessage({
              stop_reason: 'tool_use',
              toolUses: [{ id: 'lf1', name: 'list_folder', input: { path: 'docs' } }],
            }),
          );
        }
        return Promise.resolve(makeMessage({ stop_reason: 'end_turn', text: 'done' }));
      };
    })();
    const { deps, logger, tools } = makeDeps({ messages: { create } });
    tools.register({
      name: 'read_note',
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      jsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
      handler: ({ path }) =>
        Promise.resolve({
          path,
          frontmatter: null,
          body: 'body',
          mtime: 1,
          size_bytes: 4,
        }),
    });
    tools.register({
      name: 'list_folder',
      description: 'list',
      inputSchema: z.object({ path: z.string() }),
      jsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
      handler: ({ path }) =>
        Promise.resolve({
          folder: path,
          notes: [
            { path: 'docs/x.md', size_bytes: 1, mtime: 1 },
            { path: 'docs/y.md', size_bytes: 1, mtime: 1 },
          ],
          subfolders: [],
        }),
    });
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('q', [], 'chat');

    const turn = logger.sessions[0]?.turns[0];
    expect(turn).toBeDefined();
    expect(turn?.toolsUsed).toEqual(expect.arrayContaining(['read_note', 'list_folder']));
    expect(turn?.toolsUsed).toHaveLength(2);
    expect(turn?.notesReferenced).toEqual(
      expect.arrayContaining(['a.md', 'docs/x.md', 'docs/y.md']),
    );
  });

  // Phase 9 (v1.3.0) — memory injection per ADR-029.
  describe('memory cascade injection', () => {
    function captureSystemBlocks(): {
      deps: ConduitAgentDeps;
      received: MessageCreateParams[];
    } {
      const received: MessageCreateParams[] = [];
      const { deps } = makeDeps({
        messages: {
          create: (p: MessageCreateParams) => {
            received.push(p);
            return Promise.resolve(
              makeMessage({ stop_reason: 'end_turn', text: 'ok' }),
            );
          },
        },
      });
      return { deps, received };
    }

    it('injects a memory text block when the provider returns content', async () => {
      const { deps, received } = captureSystemBlocks();
      deps.memoryProvider = {
        collect: () => Promise.resolve('# Memory: CLAUDE.md\n\nuse snake_case'),
      };
      const agent = new ConduitAgent(deps, settings);
      await agent.chat('hi', [], 'chat');
      const system = received[0].system;
      expect(Array.isArray(system)).toBe(true);
      const blocks = system as Array<{ type: string; text: string; cache_control?: unknown }>;
      const memoryBlock = blocks.find((b) => b.text.startsWith('# Memory:'));
      expect(memoryBlock).toBeDefined();
      expect(memoryBlock?.cache_control).toEqual({ type: 'ephemeral' });
      // Memory should sit between constitution and hangar voice.
      const constitutionIdx = blocks.findIndex((b) => b.text === 'CONSTITUTION');
      const memoryIdx = blocks.indexOf(memoryBlock!);
      const hangarIdx = blocks.findIndex((b) => b.text === 'HANGAR');
      expect(constitutionIdx).toBeLessThan(memoryIdx);
      expect(memoryIdx).toBeLessThan(hangarIdx);
    });

    it('omits the memory block when the provider returns null', async () => {
      const { deps, received } = captureSystemBlocks();
      deps.memoryProvider = { collect: () => Promise.resolve(null) };
      const agent = new ConduitAgent(deps, settings);
      await agent.chat('hi', [], 'chat');
      const blocks = received[0].system as Array<{ text: string }>;
      const memoryBlock = blocks.find((b) => b.text.startsWith('# Memory:'));
      expect(memoryBlock).toBeUndefined();
    });

    it('omits the memory block when no provider is configured', async () => {
      const { deps, received } = captureSystemBlocks();
      // intentionally NOT setting memoryProvider
      const agent = new ConduitAgent(deps, settings);
      await agent.chat('hi', [], 'chat');
      const blocks = received[0].system as Array<{ text: string }>;
      const memoryBlock = blocks.find((b) => b.text.startsWith('# Memory:'));
      expect(memoryBlock).toBeUndefined();
    });

    it('degrades to no-memory when the provider throws (turn does not fail)', async () => {
      const { deps, received } = captureSystemBlocks();
      deps.memoryProvider = {
        collect: () => Promise.reject(new Error('disk is on fire')),
      };
      const agent = new ConduitAgent(deps, settings);
      const result = await agent.chat('hi', [], 'chat');
      expect(result.finalText).toBe('ok');
      const blocks = received[0].system as Array<{ text: string }>;
      const memoryBlock = blocks.find((b) => b.text.startsWith('# Memory:'));
      expect(memoryBlock).toBeUndefined();
    });

    it('omits the memory block when the provider returns an empty string', async () => {
      const { deps, received } = captureSystemBlocks();
      deps.memoryProvider = { collect: () => Promise.resolve('') };
      const agent = new ConduitAgent(deps, settings);
      await agent.chat('hi', [], 'chat');
      const blocks = received[0].system as Array<{ text: string }>;
      const memoryBlock = blocks.find((b) => b.text.startsWith('# Memory:'));
      expect(memoryBlock).toBeUndefined();
    });
  });
});

describe('isOverloaded()', () => {
  it('true for 503 and 529', () => {
    expect(isOverloaded(new APIError(503, undefined, 'x', new Headers()))).toBe(true);
    expect(isOverloaded(new APIError(529, undefined, 'x', new Headers()))).toBe(true);
  });

  it('false for 400/401/429/500', () => {
    expect(isOverloaded(new APIError(400, undefined, 'x', new Headers()))).toBe(false);
    expect(isOverloaded(new APIError(401, undefined, 'x', new Headers()))).toBe(false);
    expect(isOverloaded(new APIError(429, undefined, 'x', new Headers()))).toBe(false);
    expect(isOverloaded(new APIError(500, undefined, 'x', new Headers()))).toBe(false);
  });

  it('false for non-API errors', () => {
    expect(isOverloaded(new Error('something else'))).toBe(false);
    expect(isOverloaded(null)).toBe(false);
  });
});

describe('estimateCost()', () => {
  it('uses the right pricing per model', () => {
    expect(estimateCost(1_000_000, 0, 'claude-sonnet-4-6')).toBeCloseTo(3, 6);
    expect(estimateCost(0, 1_000_000, 'claude-sonnet-4-6')).toBeCloseTo(15, 6);
    expect(estimateCost(1_000_000, 0, 'claude-opus-4-7')).toBeCloseTo(15, 6);
    expect(estimateCost(1_000_000, 0, 'claude-haiku-4-5-20251001')).toBeCloseTo(1, 6);
  });

  it('falls back to Sonnet pricing for unknown models', () => {
    expect(estimateCost(1_000_000, 0, 'claude-future-99')).toBeCloseTo(3, 6);
  });
});

// Avoid unused-import warning for MessageParam (re-exported for callers):
const _typeGuard: MessageParam[] = [];
void _typeGuard;
