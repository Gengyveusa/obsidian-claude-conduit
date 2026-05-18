import { describe, expect, it } from 'vitest';
import type {
  Message,
  MessageCreateParams,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

import {
  ConduitAgent,
  type ActiveSnapshot,
  type ConduitAgentDeps,
  type MessagesAPI,
} from '../../src/agent/ConduitAgent';
import { ToolRegistry } from '../../src/agent/ToolRegistry';

/**
 * Phase 16 (v2.0.0) — ConduitAgent time-travel behavior per ADR-037
 * D6 / D7 / D8.
 *
 * Covers:
 *   - System prompt addendum carries the snapshot date + cite suffix
 *     instruction
 *   - preRetrieve fires with the snapshot's commitSha
 *   - Mode logged correctly
 *   - Other modes do NOT inject the time-travel addendum
 */

function makeMessage(text: string): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text, citations: [] }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: 'standard',
      inference_geo: null,
    },
  } as unknown as Message;
}

interface Captured {
  deps: ConduitAgentDeps;
  received: MessageCreateParams[];
  queryCalls: Array<{ query: string; commitSha: string | null | undefined }>;
  appendCalls: Array<{ mode: string }>;
}

function captureSystem(): Captured {
  const received: MessageCreateParams[] = [];
  const queryCalls: Captured['queryCalls'] = [];
  const appendCalls: Captured['appendCalls'] = [];
  const messages: MessagesAPI = {
    create: (p) => {
      received.push(p);
      return Promise.resolve(makeMessage('ok'));
    },
  };
  const tools = new ToolRegistry();
  const deps: ConduitAgentDeps = {
    messages,
    tools,
    budget: {
      assertAvailable: () => {},
      commit: () => Promise.resolve(),
      snapshot: () => ({
        tokens_input: 0,
        tokens_output: 0,
        dollars_estimated: 0,
        day: '2026-05-18',
      }),
    } as unknown as ConduitAgentDeps['budget'],
    logger: {
      startSession: () => ({
        append: (turn: { mode: string }) => {
          appendCalls.push({ mode: turn.mode });
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
    } as unknown as ConduitAgentDeps['logger'],
    systemPromptParts: { constitution: 'CONSTITUTION', hangarVoice: 'HANGAR' },
    ctx: {
      begin: () => {},
      record: () => {},
      end: () => null,
      abandon: () => {},
    } as unknown as ConduitAgentDeps['ctx'],
  };
  deps.retrieval = {
    queryUnified: (opts: { query: string; commitSha?: string | null }) => {
      queryCalls.push({ query: opts.query, commitSha: opts.commitSha });
      return Promise.resolve([]);
    },
  } as unknown as NonNullable<ConduitAgentDeps['retrieval']>;
  return { deps, received, queryCalls, appendCalls };
}

const settings = {
  defaultModel: 'claude-sonnet-4-6',
  fallbackModel: 'claude-opus-4-7',
  retrievalK: 4,
};

function systemTextOf(params: MessageCreateParams): string {
  const blocks = params.system as TextBlockParam[];
  return blocks.map((b) => b.text).join('\n---\n');
}

const SNAPSHOT: ActiveSnapshot = {
  commitSha: 'a1b2c3d4e5f6789012345678901234567890abcd',
  date: '2026-02-12',
  tag: 'v1.5.0',
};

describe('ConduitAgent time-travel mode', () => {
  it('injects the time-travel addendum with snapshot date + sha + tag', async () => {
    const { deps, received } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('What was I thinking?', [], 'time-travel', undefined, null, SNAPSHOT);
    const system = systemTextOf(received[0]);
    expect(system).toContain('Mode: TIME-TRAVEL');
    expect(system).toContain('2026-02-12');
    expect(system).toContain('a1b2c3d');
    expect(system).toContain('v1.5.0');
    expect(system).toContain('as of 2026-02-12');
    expect(system).toContain("can't edit the past");
  });

  it('handles a snapshot with no tag (untagged manual snapshot)', async () => {
    const { deps, received } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    const untagged: ActiveSnapshot = { ...SNAPSHOT, tag: null };
    await agent.chat('Q', [], 'time-travel', undefined, null, untagged);
    const system = systemTextOf(received[0]);
    expect(system).toContain('Mode: TIME-TRAVEL');
    expect(system).toContain('2026-02-12');
    expect(system).not.toMatch(/\(tagged `/);
  });

  it('pre-retrieves with the snapshot commitSha', async () => {
    const { deps, queryCalls } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('what about soltura?', [], 'time-travel', undefined, null, SNAPSHOT);
    expect(queryCalls).toEqual([
      { query: 'what about soltura?', commitSha: SNAPSHOT.commitSha },
    ]);
  });

  it('vault-qa mode passes null commitSha (current-state)', async () => {
    const { deps, queryCalls } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('q', [], 'vault-qa');
    expect(queryCalls).toEqual([{ query: 'q', commitSha: null }]);
  });

  it('does NOT inject the time-travel addendum for chat mode', async () => {
    const { deps, received } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('hi', [], 'chat');
    const system = systemTextOf(received[0]);
    expect(system).not.toContain('Mode: TIME-TRAVEL');
    expect(system).toContain('Mode: CHAT');
  });

  it('logs the time-travel mode label to the conversation log', async () => {
    const { deps, appendCalls } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('q', [], 'time-travel', undefined, null, SNAPSHOT);
    expect(appendCalls).toEqual([{ mode: 'time-travel' }]);
  });

  it('time-travel pre-retrieve is a no-op when retrieval is unavailable', async () => {
    const { deps, received, queryCalls } = captureSystem();
    // Strip retrieval — simulates an operator with no HF token who
    // somehow landed in time-travel mode (the UI prevents this, but
    // the agent must degrade gracefully).
    delete deps.retrieval;
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('q', [], 'time-travel', undefined, null, SNAPSHOT);
    expect(queryCalls).toEqual([]);
    expect(received).toHaveLength(1);
  });
});
