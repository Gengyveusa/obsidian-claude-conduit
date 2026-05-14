import type { ActivityLog } from '../activity/ActivityLog';
import type { ToolRegistry } from '../agent/ToolRegistry';

/**
 * Phase 6.5 (v0.9.0) — MCP server scaffold per
 * [ADR-021](../../docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md).
 *
 * **PR 1 ships the skeleton only** — `start()` / `stop()` are wired but
 * no transport is bound yet. The HTTP/SSE listener (D2 (b)) lands in
 * PR 2; tool registration (D9) in PR 3; activity emission with
 * `source:` field (D5) in PR 4.
 *
 * Lifecycle: `main.ts` constructs the server when `settings.mcpEnabled`
 * flips on. `start()` is idempotent — calling it twice is a no-op.
 * `stop()` releases any bound port + cancels in-flight requests.
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
 *   // ... external client calls now flow through `toolRegistry.execute(...)`
 *   await server.stop();
 */
export interface McpServerDeps {
  /** SHA-256 hex hash of the bearer token. Empty string = no auth (refuse to start). */
  tokenHash: string;
  /** Localhost port to bind. Default 8765 per ADR-021 D6. */
  port: number;
  /** MCP `clientInfo.name` allowlist. Empty = any authenticated client. */
  allowedClients: string[];
  /** Shared tool registry — same instance the in-app agent uses. */
  toolRegistry: ToolRegistry;
  /** Optional — events emitted with `source: 'mcp:<client>'` per ADR-021 D5. */
  activityLog?: ActivityLog;
  /** Test-injectable logger. */
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

export class McpServer {
  private readonly deps: McpServerDeps;
  private readonly logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  private started = false;

  constructor(deps: McpServerDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? {
      warn: (msg) => console.warn(`[mcp-server] ${msg}`),
      info: (msg) => console.warn(`[mcp-server] ${msg}`),
    };
  }

  /**
   * Bind the configured port and accept MCP requests. Idempotent —
   * calling twice while started is a no-op. Returns once the server
   * is ready to accept connections (or throws on bind failure).
   *
   * **PR 1:** stub — flips the `started` flag, logs an info line, and
   * returns. PR 2 wires the actual HTTP/SSE listener.
   */
  start(): Promise<void> {
    if (this.started) {
      return Promise.resolve();
    }
    if (this.deps.tokenHash.length === 0) {
      return Promise.reject(
        new Error(
          'McpServer: refusing to start without a configured bearer token (settings.mcpToken).',
        ),
      );
    }
    this.logger.info?.(
      `start scaffold — port ${this.deps.port}, ${this.deps.allowedClients.length} allowed client(s), HTTP listener wires in PR 2`,
    );
    this.started = true;
    return Promise.resolve();
  }

  /**
   * Stop the server and release the bound port. Idempotent.
   */
  stop(): Promise<void> {
    if (!this.started) {
      return Promise.resolve();
    }
    this.logger.info?.('stop scaffold — released no resources yet (PR 1)');
    this.started = false;
    return Promise.resolve();
  }

  /** True if `start()` has been called and `stop()` has not. */
  isRunning(): boolean {
    return this.started;
  }
}
