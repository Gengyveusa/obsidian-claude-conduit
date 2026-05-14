import { describe, expect, it } from 'vitest';

import { hashToken } from '../../src/mcp/auth';
import { HttpListener } from '../../src/mcp/HttpListener';
import { McpServer } from '../../src/mcp/McpServer';
import { ToolRegistry } from '../../src/agent/ToolRegistry';

const SAMPLE_TOKEN = 'sample-bearer-token-1234567890';

async function makeServer(
  over: Partial<{ tokenHash: string; port: number; allowedClients: string[] }> = {},
): Promise<McpServer> {
  const tokenHash = over.tokenHash ?? (await hashToken(SAMPLE_TOKEN));
  return new McpServer({
    tokenHash,
    port: over.port ?? 0, // ephemeral; HttpListener picks
    allowedClients: over.allowedClients ?? [],
    toolRegistry: new ToolRegistry(),
    logger: { warn: () => {}, info: () => {} },
  });
}

describe('McpServer (v0.9.0 PR 2 — HTTP listener wired)', () => {
  it('binds and reports running', async () => {
    const server = await makeServer();
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(server.boundPort()).toBeGreaterThan(0);
    await server.stop();
  });

  it('start() is idempotent', async () => {
    const server = await makeServer();
    await server.start();
    const port1 = server.boundPort();
    await server.start();
    const port2 = server.boundPort();
    expect(port1).toBe(port2);
    await server.stop();
  });

  it('stop() releases the running flag and the port', async () => {
    const server = await makeServer();
    await server.start();
    await server.stop();
    expect(server.isRunning()).toBe(false);
    expect(server.boundPort()).toBeNull();
  });

  it('stop() before start() is a no-op', async () => {
    const server = await makeServer();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('refuses to start without a configured token hash', async () => {
    const server = await makeServer({ tokenHash: '' });
    await expect(server.start()).rejects.toThrow(/refusing to start/);
    expect(server.isRunning()).toBe(false);
  });

  it('responds to authenticated POST with the PR 2 echo handler', async () => {
    const server = await makeServer();
    await server.start();
    const port = server.boundPort();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SAMPLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ping: 'pong' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      server: 'sagittarius',
      stage: 'pr-2-scaffold',
      echo: { ping: 'pong' },
    });
    await server.stop();
  });

  it('rejects authenticated GET with 405 (POST/OPTIONS only)', async () => {
    const server = await makeServer();
    await server.start();
    const port = server.boundPort();
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${SAMPLE_TOKEN}` },
    });
    expect(res.status).toBe(405);
    await server.stop();
  });

  it('accepts an injected HttpListener for tests', async () => {
    const tokenHash = await hashToken(SAMPLE_TOKEN);
    const injected = new HttpListener({
      port: 0,
      tokenHash,
      logger: { warn: () => {} },
    });
    const server = new McpServer({
      tokenHash,
      port: 0,
      allowedClients: [],
      toolRegistry: new ToolRegistry(),
      listener: injected,
      logger: { warn: () => {}, info: () => {} },
    });
    await server.start();
    expect(server.boundPort()).toBe(injected.boundPort());
    await server.stop();
  });
});
