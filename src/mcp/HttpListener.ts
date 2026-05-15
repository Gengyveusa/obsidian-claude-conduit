import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import type { McpTokenEntry } from '../settings/types';

import { parseBearerHeader, verifyToken } from './auth';
import { authenticateBearerHeader } from './tokens';

/**
 * Phase 6.5 (v0.9.0 PR 2) — HTTP listener for the MCP bridge per
 * [ADR-021](../../docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md)
 * D2 (HTTP/SSE on localhost) + D4 (127.0.0.1 only) + D3 (bearer auth).
 *
 * Thin wrapper over Node's `http.createServer`. Owns:
 *
 *   - bind / unbind lifecycle
 *   - Bearer-token auth (401 on miss; constant-time compare against
 *     `tokenHash` via `verifyToken`)
 *   - method gating (only POST + OPTIONS reach the handler in PR 2;
 *     PR 3 will add SSE GET when wiring the MCP protocol)
 *   - request → handler delegation
 *
 * PR 2's handler is a stub that returns `{ok: true}` for every
 * authenticated request. PR 3 swaps it for the MCP SDK's JSON-RPC
 * dispatcher.
 *
 * @example
 *   const listener = new HttpListener({ port: 8765, tokenHash: hash });
 *   listener.setHandler(async (req, body) => ({ ok: true }));
 *   await listener.start();
 *   // ... receive POST /mcp with Authorization: Bearer <token> + JSON body
 *   await listener.stop();
 */

export interface HttpListenerDeps {
  /** Localhost port to bind. */
  port: number;
  /**
   * **Deprecated as of v1.4.2 (ADR-032).** Legacy single-token mode.
   * When `tokens` is also provided, `tokens` wins; this field is kept
   * for tests + back-compat. Empty string + empty `tokens` = reject
   * everything (401).
   */
  tokenHash?: string;
  /**
   * Phase 6.7+ (v1.4.2) — accessor for the current token array per
   * [ADR-032](../../docs/2026-05-15-adr-032-mcp-token-slots.md).
   * Read on every auth attempt so live settings edits (operator
   * adds/revokes a token) take effect on the next request.
   *
   * Empty array = reject everything. When both `tokens` and
   * `tokenHash` are supplied, `tokens` wins.
   */
  tokens?: () => ReadonlyArray<McpTokenEntry>;
  /**
   * Phase 6.7+ (v1.4.2) — called on every successful auth so the
   * plugin can update `lastUsedAt` per ADR-032 D6. Receives the
   * matching entry's name.
   */
  onTokenUsed?: (tokenName: string) => void;
  /** Test-injectable logger. */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

/** Authentication outcome attached to each authenticated request. */
export interface AuthContext {
  /** Matching token's name; empty string for legacy single-token mode. */
  tokenName: string;
  /** Scope from the matching entry; `delete` for legacy mode (all-allow). */
  scope: McpTokenEntry['scope'];
}

/** Result type for the request handler. JSON-serialized into the response body. */
export interface HandlerResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * Handler signature. Receives the parsed body (JSON if Content-Type
 * was application/json, otherwise the raw text). Throws are caught
 * and turned into 500 responses with `{error: msg}`.
 */
export type HttpHandler = (
  req: IncomingMessage,
  body: unknown,
  auth: AuthContext,
) => Promise<HandlerResult>;

const BIND_ADDRESS = '127.0.0.1';
const MAX_BODY_BYTES = 1 << 20; // 1 MiB; MCP messages are tiny — anything bigger is abuse.

export class HttpListener {
  private readonly logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  private readonly tokenHash: string;
  private readonly tokens: (() => ReadonlyArray<McpTokenEntry>) | null;
  private readonly onTokenUsed: ((tokenName: string) => void) | null;
  private readonly port: number;
  private server: Server | null = null;
  private handler: HttpHandler | null = null;

  constructor(deps: HttpListenerDeps) {
    this.port = deps.port;
    this.tokenHash = deps.tokenHash ?? '';
    this.tokens = deps.tokens ?? null;
    this.onTokenUsed = deps.onTokenUsed ?? null;
    this.logger = deps.logger ?? {
      warn: (msg) => console.warn(`[mcp-http] ${msg}`),
      info: (msg) => console.warn(`[mcp-http] ${msg}`),
    };
  }

  /**
   * Register the request handler. Must be called before `start()`.
   * Replaceable for tests.
   */
  setHandler(handler: HttpHandler): void {
    this.handler = handler;
  }

  /** True if the server is bound to a port. */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Return the actually-bound port. Differs from `deps.port` when 0
   * was passed (ephemeral) — useful in tests.
   */
  boundPort(): number | null {
    if (this.server === null) {
      return null;
    }
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') {
      return null;
    }
    return addr.port;
  }

  /**
   * Bind to `127.0.0.1:port` and start accepting requests. Rejects on
   * bind failure (EADDRINUSE etc.).
   */
  start(): Promise<void> {
    if (this.server !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`request crashed: ${msg}`);
          try {
            this.writeJson(res, 500, { error: 'internal error' });
          } catch {
            // already-headed-out; nothing to do
          }
        });
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (this.server === null) {
          // Initial bind failure.
          reject(err);
        } else {
          this.logger.warn(`server error post-start: ${err.message}`);
        }
      });
      server.listen(this.port, BIND_ADDRESS, () => {
        this.server = server;
        this.logger.info?.(`bound to ${BIND_ADDRESS}:${this.boundPort()}`);
        resolve();
      });
    });
  }

  /**
   * Unbind and stop accepting new requests. Existing in-flight
   * requests complete naturally. Idempotent.
   */
  stop(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return Promise.resolve();
    }
    this.server = null;
    return new Promise((resolve) => {
      server.close(() => {
        this.logger.info?.('stopped');
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      // Preflight — accept everything from localhost; no CORS hardening
      // for v0.9.0 (localhost-only per D4).
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      this.writeJson(res, 405, { error: 'method not allowed; use POST' });
      return;
    }

    // Auth — v1.4.2 (ADR-032): prefer the token-array accessor when
    // configured; fall back to legacy single-hash mode for back-compat
    // (existing tests + pre-migration installs).
    const authHeader = req.headers.authorization ?? null;
    let auth: AuthContext;
    if (this.tokens !== null) {
      const tokens = this.tokens();
      if (tokens.length === 0) {
        this.writeJson(res, 401, { error: 'server has no MCP tokens configured' });
        return;
      }
      const lookup = await authenticateBearerHeader(authHeader, tokens);
      if (!lookup.ok || lookup.entry === null) {
        this.writeJson(res, 401, { error: 'invalid Bearer token' });
        return;
      }
      this.onTokenUsed?.(lookup.entry.name);
      auth = { tokenName: lookup.entry.name, scope: lookup.entry.scope };
    } else {
      const candidateToken = parseBearerHeader(authHeader);
      if (candidateToken === null) {
        this.writeJson(res, 401, { error: 'missing Bearer token' });
        return;
      }
      if (this.tokenHash.length === 0) {
        this.writeJson(res, 401, { error: 'server token not configured' });
        return;
      }
      const ok = await verifyToken(candidateToken, this.tokenHash);
      if (!ok) {
        this.writeJson(res, 401, { error: 'invalid Bearer token' });
        return;
      }
      // Legacy mode: no entry to attach. Use 'delete' scope so the
      // legacy path passes any per-scope checks — global toggles
      // remain the gate.
      auth = { tokenName: '', scope: 'delete' };
    }

    // Body.
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeJson(res, 413, { error: msg });
      return;
    }

    let body: unknown = bodyText;
    const contentType = req.headers['content-type'] ?? '';
    if (contentType.includes('application/json') && bodyText.length > 0) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        this.writeJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
    }

    if (this.handler === null) {
      this.writeJson(res, 503, { error: 'no handler configured' });
      return;
    }

    let result: HandlerResult;
    try {
      result = await this.handler(req, body, auth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`handler threw: ${msg}`);
      this.writeJson(res, 500, { error: msg });
      return;
    }
    this.writeJson(res, result.status ?? 200, result.body, result.headers);
  }

  private writeJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}
