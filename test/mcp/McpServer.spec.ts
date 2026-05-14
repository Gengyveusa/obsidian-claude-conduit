import { describe, expect, it } from 'vitest';

import { McpServer } from '../../src/mcp/McpServer';
import { ToolRegistry } from '../../src/agent/ToolRegistry';

function makeServer(over: Partial<{ tokenHash: string; port: number; allowedClients: string[] }> = {}) {
  return new McpServer({
    tokenHash: over.tokenHash ?? 'a'.repeat(64),
    port: over.port ?? 8765,
    allowedClients: over.allowedClients ?? [],
    toolRegistry: new ToolRegistry(),
    logger: { warn: () => {}, info: () => {} },
  });
}

describe('McpServer (v0.9.0 PR 1 scaffold)', () => {
  it('starts and reports running', async () => {
    const server = makeServer();
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it('start() is idempotent — calling twice is fine', async () => {
    const server = makeServer();
    await server.start();
    await server.start();
    expect(server.isRunning()).toBe(true);
  });

  it('stop() releases the running flag', async () => {
    const server = makeServer();
    await server.start();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('stop() before start() is a no-op', async () => {
    const server = makeServer();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('refuses to start without a configured token hash', async () => {
    const server = makeServer({ tokenHash: '' });
    await expect(server.start()).rejects.toThrow(/refusing to start/);
    expect(server.isRunning()).toBe(false);
  });
});
