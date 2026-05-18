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

function passthroughTool(name: string): ToolDefinition<{ path: string }, { path: string }> {
  return {
    name,
    description: 'fake tool for write-block tests',
    inputSchema: z.object({ path: z.string() }),
    jsonSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: ({ path }) => Promise.resolve({ path }),
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

  describe('Phase 16 — write-block (ADR-037 D7)', () => {
    it('setWriteBlock(null) is the default — writes pass through', async () => {
      const reg = new ToolRegistry();
      reg.register(passthroughTool('create_note'));
      expect(reg.getWriteBlock()).toBeNull();
      const out = await reg.execute('create_note', { path: 'a.md' });
      expect(out).toEqual({ path: 'a.md' });
    });

    it('setWriteBlock(reason) throws the reason for write-tool execute()', async () => {
      const reg = new ToolRegistry();
      reg.register(passthroughTool('patch_note'));
      reg.setWriteBlock("Time-travel mode is read-only — you can't edit the past.");
      expect(reg.getWriteBlock()).toBe(
        "Time-travel mode is read-only — you can't edit the past.",
      );
      await expect(reg.execute('patch_note', { path: 'a.md' })).rejects.toThrow(
        /Time-travel mode is read-only/,
      );
    });

    it('write-block does not affect reads', async () => {
      const reg = new ToolRegistry();
      reg.register(passthroughTool('read_note'));
      reg.setWriteBlock('blocked');
      const out = await reg.execute('read_note', { path: 'a.md' });
      expect(out).toEqual({ path: 'a.md' });
    });

    it('setWriteBlock(null) clears a previously-set block', async () => {
      const reg = new ToolRegistry();
      reg.register(passthroughTool('append_to_note'));
      reg.setWriteBlock('blocked');
      await expect(reg.execute('append_to_note', { path: 'a.md' })).rejects.toThrow();
      reg.setWriteBlock(null);
      const out = await reg.execute('append_to_note', { path: 'a.md' });
      expect(out).toEqual({ path: 'a.md' });
    });

    it('write-block applies to every name in WRITE_TOOL_NAMES', async () => {
      const reg = new ToolRegistry();
      const writeNames = [
        'create_note',
        'append_to_note',
        'patch_note',
        'rewrite_section',
        'add_frontmatter',
        'move_note',
        'rename_note',
        'delete_note',
        'link_notes',
        'file_asset',
      ];
      for (const name of writeNames) {
        reg.register(passthroughTool(name));
      }
      reg.setWriteBlock('locked');
      for (const name of writeNames) {
        await expect(reg.execute(name, { path: 'x' })).rejects.toThrow('locked');
      }
    });
  });
});
