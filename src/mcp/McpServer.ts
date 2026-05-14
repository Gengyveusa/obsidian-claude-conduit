import type { ActivityLog } from '../activity/ActivityLog';
import type { ToolRegistry } from '../agent/ToolRegistry';
import type { WriteToolContext } from '../writes/WriteToolContext';

import { HttpListener, type HandlerResult, type HttpHandler } from './HttpListener';
import { McpHandler } from './McpHandler';
import type { WriteGateSettings } from './WriteGate';

/**
 * Phase 6.5 (v0.9.0) — MCP server per
 * [ADR-021](../../docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md).
 *
 * Composition:
 *   - `HttpListener` (PR 2) — owns the socket, parses bodies, runs auth
 *   - this class — wires the listener's handler to the (future) MCP
 *     protocol dispatcher
 *
 * **PR 2 scope:** lifecycle + auth + stub handler. The handler returns
 * `{ ok: true, echo: body }` for every authenticated POST. PR 3 swaps
 * the stub for the `@modelcontextprotocol/sdk` JSON-RPC dispatcher.
 *
 * @example
 *   const server = new McpServer({
 *     tokenHash: settings.mcpToken,
 *     port: settings.mcpPort,
 *     allowedClients: settings.mcpAllowedClients,
 *     toolRegistry,
 *     activityLog,
 *   });
 *   await server.start();
 *   // POST http://127.0.0.1:8765/ with Authorization: Bearer <token>
 *   await server.stop();
 */
export interface McpServerDeps {
  /** SHA-256 hex hash of the bearer token. Empty string = refuse to start. */
  tokenHash: string;
  /** Localhost port to bind. Default 8765 per ADR-021 D6. */
  port: number;
  /** MCP `clientInfo.name` allowlist. Empty = any authenticated client. */
  allowedClients: string[];
  /** Shared tool registry — same instance the in-app agent uses. */
  toolRegistry: ToolRegistry;
  /** Plugin version string — surfaced via MCP `initialize` `serverInfo.version`. */
  pluginVersion: string;
  /** Optional — events emitted with `source: 'mcp:<client>'` per ADR-021 D5. */
  activityLog?: ActivityLog;
  /**
   * Phase 6.7 (v1.0.9) — supply both `writeSettings` and `writeContext`
   * to enable MCP write tools. Omit both to keep the bridge read-only.
   * Supplying one without the other throws at handler construction.
   */
  writeSettings?: () => WriteGateSettings & {
    mcpWriteRateLimitPerHour: number;
    mcpWriteQueueTimeoutMs: number;
  };
  writeContext?: WriteToolContext;
  /** Test-injectable logger. */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  /** Test seam — inject a pre-constructed listener (and skip real bind). */
  listener?: HttpListener;
  /** Test-injectable clock for the rate limiter; epoch ms. */
  clock?: () => number;
}

export class McpServer {
  private readonly deps: McpServerDeps;
  private readonly logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  private readonly listener: HttpListener;
  private readonly mcpHandler: McpHandler;
  private started = false;

  constructor(deps: McpServerDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? {
      warn: (msg) => console.warn(`[mcp-server] ${msg}`),
      info: (msg) => console.warn(`[mcp-server] ${msg}`),
    };
    this.mcpHandler = new McpHandler({
      toolRegistry: deps.toolRegistry,
      pluginVersion: deps.pluginVersion,
      logger: this.logger,
      ...(deps.activityLog !== undefined && { activityLog: deps.activityLog }),
      ...(deps.writeSettings !== undefined && { writeSettings: deps.writeSettings }),
      ...(deps.writeContext !== undefined && { writeContext: deps.writeContext }),
      ...(deps.clock !== undefined && { clock: deps.clock }),
    });
    this.listener =
      deps.listener ??
      new HttpListener({
        port: deps.port,
        tokenHash: deps.tokenHash,
        logger: this.logger,
      });
    this.listener.setHandler(this.makeHandler());
  }

  /**
   * Bind the configured port and accept MCP requests. Idempotent.
   * Throws on bind failure (EADDRINUSE etc.).
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.deps.tokenHash.length === 0) {
      throw new Error(
        'McpServer: refusing to start without a configured bearer token (settings.mcpToken).',
      );
    }
    await this.listener.start();
    this.started = true;
    this.logger.info?.(
      `started — port ${this.listener.boundPort() ?? this.deps.port}, ` +
        `${this.deps.allowedClients.length} allowed client(s)`,
    );
  }

  /** Stop the server and release the bound port. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.listener.stop();
    this.started = false;
    this.logger.info?.('stopped');
  }

  /** True if `start()` has been called and `stop()` has not. */
  isRunning(): boolean {
    return this.started;
  }

  /** Return the actually-bound port (useful when port=0 ephemeral binding). */
  boundPort(): number | null {
    return this.listener.boundPort();
  }

  /**
   * Bridge between the auth-gated `HttpListener` and the JSON-RPC
   * `McpHandler`. Authenticated POST → parse body (HttpListener did
   * that) → dispatch via the MCP handler → JSON-RPC response in body.
   * All errors are turned into JSON-RPC errors inside the handler;
   * the HTTP status is always 200 (per JSON-RPC convention where the
   * transport is healthy but the payload may carry an error).
   */
  private makeHandler(): HttpHandler {
    return async (_req, body): Promise<HandlerResult> => {
      const jsonRpcResponse = await this.mcpHandler.handle(body);
      return {
        status: 200,
        body: jsonRpcResponse,
      };
    };
  }
}
