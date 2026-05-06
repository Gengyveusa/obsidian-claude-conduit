import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ToolRegistry } from '../../src/agent/ToolRegistry';
import type { ToolDefinition } from '../../src/agent/types';

function echoTool(name = 'echo'): ToolDefinition<{ message: string }, string> {
  return {
    name,
    description: 'Echo the message back.',
    inputSchema: z.object({ message: z.string().min(1) }),
    jsonSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    handler: ({ message }) => Promise.resolve(message.toUpperCase()),
  };
}

describe('ToolRegistry', () => {
  it('register + has + names() report registered tools in order', () => {
    const reg = new ToolRegistry();
    expect(reg.has('echo')).toBe(false);
    reg.register(echoTool('echo'));
    reg.register(echoTool('shout'));
    expect(reg.has('echo')).toBe(true);
    expect(reg.names()).toEqual(['echo', 'shout']);
  });

  it('rejects duplicate registration with an actionable error', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool('echo'));
    expect(() => reg.register(echoTool('echo'))).toThrow(/already registered/);
  });

  it('schemas() emits the Anthropic-shaped tool definitions', () => {
    const reg = new ToolRegistry();
    reg.register(echoTool('echo'));
    expect(reg.schemas()).toEqual([
      {
        name: 'echo',
        description: 'Echo the message back.',
        input_schema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    ]);
  });

  it('execute() validates input via Zod and dispatches the handler', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool());
    const out = await reg.execute('echo', { message: 'hello' });
    expect(out).toBe('HELLO');
  });

  it('execute() throws on missing required field, naming the path', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool());
    await expect(reg.execute('echo', {})).rejects.toThrow(
      /input validation failed for 'echo'.*message/,
    );
  });

  it('execute() throws on unknown tool name and lists available ones', async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool('echo'));
    reg.register(echoTool('shout'));
    await expect(reg.execute('missing', {})).rejects.toThrow(
      /no tool named 'missing'.*Available tools: echo, shout/,
    );
  });

  it('execute() with no tools registered surfaces "(none)"', async () => {
    const reg = new ToolRegistry();
    await expect(reg.execute('anything', {})).rejects.toThrow(/Available tools: \(none\)/);
  });
});
