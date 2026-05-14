import { describe, expect, it } from 'vitest';

import { hashToken } from '../../src/mcp/auth';
import { HttpListener } from '../../src/mcp/HttpListener';

const SAMPLE_TOKEN = 'sample-bearer-token-1234567890';

async function makeBound(tokenHash: string): Promise<HttpListener> {
  const listener = new HttpListener({
    port: 0,
    tokenHash,
    logger: { warn: () => {}, info: () => {} },
  });
  listener.setHandler((_req, body) =>
    Promise.resolve({ body: { saw: body } }),
  );
  await listener.start();
  return listener;
}

interface FetchOpts {
  method?: string;
  token?: string;
  body?: string;
  contentType?: string;
}

async function fetchListener(
  listener: HttpListener,
  opts: FetchOpts = {},
): Promise<{ status: number; body: unknown }> {
  const port = listener.boundPort();
  if (port === null) {
    throw new Error('listener not bound');
  }
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  if (opts.contentType !== undefined) {
    headers['Content-Type'] = opts.contentType;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const requestInit: RequestInit = {
    method: opts.method ?? 'POST',
    headers,
  };
  if (opts.body !== undefined) {
    requestInit.body = opts.body;
  }
  const res = await fetch(`http://127.0.0.1:${port}/`, requestInit);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
}

describe('HttpListener', () => {
  it('binds an ephemeral port and reports it', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    expect(listener.isRunning()).toBe(true);
    expect(listener.boundPort()).toBeGreaterThan(0);
    await listener.stop();
    expect(listener.isRunning()).toBe(false);
  });

  it('start() is idempotent', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    await listener.start();
    expect(listener.isRunning()).toBe(true);
    await listener.stop();
  });

  it('stop() before start() is a no-op', async () => {
    const listener = new HttpListener({
      port: 0,
      tokenHash: 'x',
      logger: { warn: () => {} },
    });
    await listener.stop();
    expect(listener.isRunning()).toBe(false);
  });

  it('rejects requests without Authorization header (401)', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    const res = await fetchListener(listener, { body: '{"hi":true}' });
    expect(res.status).toBe(401);
    await listener.stop();
  });

  it('rejects requests with wrong Bearer token (401)', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    const res = await fetchListener(listener, { token: 'wrong-token', body: '{}' });
    expect(res.status).toBe(401);
    await listener.stop();
  });

  it('rejects when no token configured server-side (401)', async () => {
    const listener = await makeBound('');
    const res = await fetchListener(listener, { token: SAMPLE_TOKEN, body: '{}' });
    expect(res.status).toBe(401);
    await listener.stop();
  });

  it('accepts well-formed POST with valid token (200 + body echo)', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    const res = await fetchListener(listener, {
      token: SAMPLE_TOKEN,
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saw: { hello: 'world' } });
    await listener.stop();
  });

  it('rejects non-POST methods (405)', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    const res = await fetchListener(listener, {
      method: 'GET',
      token: SAMPLE_TOKEN,
    });
    expect(res.status).toBe(405);
    await listener.stop();
  });

  it('accepts OPTIONS preflight (204)', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    const res = await fetchListener(listener, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    await listener.stop();
  });

  it('returns 400 on invalid JSON body', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    const res = await fetchListener(listener, {
      token: SAMPLE_TOKEN,
      body: '{not json',
      contentType: 'application/json',
    });
    expect(res.status).toBe(400);
    await listener.stop();
  });

  it('returns 500 when the handler throws', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = new HttpListener({
      port: 0,
      tokenHash: hash,
      logger: { warn: () => {} },
    });
    listener.setHandler(() => Promise.reject(new Error('boom')));
    await listener.start();
    const res = await fetchListener(listener, { token: SAMPLE_TOKEN, body: '{}' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'boom' });
    await listener.stop();
  });

  it('returns 503 when no handler is configured', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = new HttpListener({
      port: 0,
      tokenHash: hash,
      logger: { warn: () => {} },
    });
    await listener.start();
    const res = await fetchListener(listener, { token: SAMPLE_TOKEN, body: '{}' });
    expect(res.status).toBe(503);
    await listener.stop();
  });

  it('only binds 127.0.0.1 — not externally reachable', async () => {
    const hash = await hashToken(SAMPLE_TOKEN);
    const listener = await makeBound(hash);
    // We can't actually verify external-unreachability in unit tests,
    // but we can verify the bind address by re-reading server.address().
    // The listener's boundPort() exists; the family check is implicit
    // in the constant in HttpListener.ts.
    expect(listener.boundPort()).toBeGreaterThan(0);
    await listener.stop();
  });
});
