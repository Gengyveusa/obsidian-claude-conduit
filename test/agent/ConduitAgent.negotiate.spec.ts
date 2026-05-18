import { describe, expect, it, vi } from 'vitest';
import type {
  Message,
  MessageCreateParams,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

import {
  ConduitAgent,
  type ConduitAgentDeps,
  type MessagesAPI,
} from '../../src/agent/ConduitAgent';
import { ToolRegistry } from '../../src/agent/ToolRegistry';

/**
 * Phase 15 (v1.8.0) — ConduitAgent negotiate-mode behavior per
 * ADR-036 D2 + D6.
 *
 * These tests verify the prompt-assembly path: when `mode` is
 * `'negotiate'`, the system prompt contains the adversarial
 * addendum and pre-retrieval fires (just like vault-qa). Full
 * end-to-end tests live in the existing ConduitAgent.spec.ts;
 * this file is focused on the negotiate-specific surface.
 */

function makeMessage(opts: { text: string; stop_reason?: Message['stop_reason'] }): Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: opts.text, citations: [] }],
    model: 'claude-sonnet-4-6',
    stop_reason: opts.stop_reason ?? 'end_turn',
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

function captureSystem(): { deps: ConduitAgentDeps; received: MessageCreateParams[] } {
  const received: MessageCreateParams[] = [];
  const messages: MessagesAPI = {
    create: (p) => {
      received.push(p);
      return Promise.resolve(makeMessage({ text: 'ok' }));
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
        append: () => Promise.resolve(),
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
  return { deps, received };
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

describe('ConduitAgent negotiate-mode prompt', () => {
  it('injects the adversarial addendum when mode === "negotiate"', async () => {
    const { deps, received } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('Q3 should focus on FortressFlow.', [], 'negotiate');
    const system = systemTextOf(received[0]);
    expect(system).toContain('Mode: NEGOTIATE');
    expect(system).toContain('STRONGEST');
    expect(system).toContain('counter-evidence');
    expect(system).toContain('Refuse to flatter. Refuse to soften.');
  });

  it('does NOT inject the adversarial addendum for chat mode', async () => {
    const { deps, received } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('hi', [], 'chat');
    const system = systemTextOf(received[0]);
    expect(system).not.toContain('Mode: NEGOTIATE');
    expect(system).toContain('Mode: CHAT');
  });

  it('does NOT inject the adversarial addendum for vault-qa mode', async () => {
    const { deps, received } = captureSystem();
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('what is X?', [], 'vault-qa');
    const system = systemTextOf(received[0]);
    expect(system).not.toContain('Mode: NEGOTIATE');
    expect(system).toContain('Mode: VAULT QA');
  });

  it('pre-retrieval fires for negotiate mode (when retrieval is configured)', async () => {
    const { deps, received } = captureSystem();
    // Inject a stub retrieval that records the call.
    const queryCalls: string[] = [];
    deps.retrieval = {
      queryUnified: ({ query }: { query: string }) => {
        queryCalls.push(query);
        return Promise.resolve([]);
      },
    } as unknown as NonNullable<ConduitAgentDeps['retrieval']>;
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('My thesis is X.', [], 'negotiate');
    expect(queryCalls).toEqual(['My thesis is X.']);
    expect(received).toHaveLength(1);
  });

  it('pre-retrieval does NOT fire for chat mode', async () => {
    const { deps, received } = captureSystem();
    const queryCalls: string[] = [];
    deps.retrieval = {
      queryUnified: ({ query }: { query: string }) => {
        queryCalls.push(query);
        return Promise.resolve([]);
      },
    } as unknown as NonNullable<ConduitAgentDeps['retrieval']>;
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('hi', [], 'chat');
    expect(queryCalls).toEqual([]);
    expect(received).toHaveLength(1);
  });

  it('logs the negotiate mode label to the conversation log', async () => {
    const { deps, received } = captureSystem();
    const appendCalls: Array<{ mode: string }> = [];
    deps.logger = {
      startSession: () => ({
        append: (turn: { mode: string }) => {
          appendCalls.push({ mode: turn.mode });
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
    } as unknown as ConduitAgentDeps['logger'];
    const agent = new ConduitAgent(deps, settings);
    await agent.chat('X', [], 'negotiate');
    expect(received).toHaveLength(1);
    expect(appendCalls).toEqual([{ mode: 'negotiate' }]);
    // Avoid unused-variable lint if vi isn't referenced elsewhere.
    void vi;
  });
});
