import type { ActivityLog } from '../activity/ActivityLog';
import type { ToolRegistry } from '../agent/ToolRegistry';
import type { WriteToolContext } from '../writes/WriteToolContext';

import {
  JSON_RPC_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  errorResponse,
  parseRequest,
  successResponse,
} from './JsonRpc';
import {
  type McpToolCallResult,
  isMcpExposed,
  isMcpWriteTool,
  mcpExposedToolNames,
  mcpToolListFrom,
  wrapToolResult,
} from './McpToolAdapter';
import {
  WriteRateLimiter,
  type WriteGateSettings,
  evaluateWriteGate,
} from './WriteGate';

/**
 * Phase 6.5 (v0.9.0 PR 3) — MCP JSON-RPC dispatcher per
 * [ADR-021](../../docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md)
 * D9. Implements the three MCP methods needed for read-only tool access:
 *
 *   - `initialize` — handshake; returns server `serverInfo` + supported
 *     capabilities + protocol version
 *   - `tools/list` — return the 5 exposed read-only tools' MCP schemas
 *   - `tools/call` — invoke a tool through the shared `ToolRegistry`,
 *     wrap the result in MCP content shape
 *
 * Everything else returns `Method not found`. We hand-roll the dispatch
 * instead of using the SDK's `Protocol`/`Transport` machinery because
 * v0.9.0 is request-response only — no streaming, batching, or
 * notifications. The SDK is bundled for future protocol stability.
 */

export interface McpHandlerDeps {
  toolRegistry: ToolRegistry;
  /** Plugin version string surfaced in `initialize` `serverInfo.version`. */
  pluginVersion: string;
  /** Optional activity log — records `write.committed`-style events with `source: 'mcp:<client>'`. */
  activityLog?: ActivityLog;
  /**
   * Phase 6.7 (v1.0.9) — accessor for the write-side gating settings.
   * A function so each `tools/list` and `tools/call` reads the current
   * values without bouncing the MCP server when settings flip. Per
   * ADR-025 D1+D6+D7+D9. Omit to disable write-side entirely (the
   * handler then behaves identically to v0.9.x).
   *
   * v1.1.0 (Slice 3) adds `mcpWriteQueueTimeoutMs` for the D2 (c)
   * hybrid block-then-queue transport — registry.execute races
   * against this timeout; on expiry the MCP response returns `queued`
   * while the underlying tool keeps running in the background and
   * commits to `TransactionLog` when the user eventually responds in
   * the external-proposals side panel.
   */
  writeSettings?: () => WriteGateSettings & {
    mcpWriteRateLimitPerHour: number;
    mcpWriteQueueTimeoutMs: number;
  };
  /**
   * Phase 6.7 (v1.0.9) — the singleton `WriteToolContext` the in-app
   * agent uses. McpHandler calls `begin()`/`end()` around each write
   * tool invocation to plumb `source: 'mcp:<client>'` into the
   * `Transaction` per ADR-025 D5. Required when `writeSettings` is
   * provided.
   */
  writeContext?: WriteToolContext;
  /** Test-injectable logger. */
  logger?: { warn: (msg: string) => void };
  /** Test-injectable clock for the rate limiter; returns epoch ms. */
  clock?: () => number;
}

/** MCP protocol version this server speaks. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Handle one parsed JSON body (the request) and produce a JSON-RPC
 * response. Caller is responsible for the HTTP framing. Never throws —
 * unexpected errors are converted to JSON-RPC `internal error` responses.
 */
export class McpHandler {
  private readonly registry: ToolRegistry;
  private readonly pluginVersion: string;
  private readonly logger: { warn: (msg: string) => void };
  private readonly activityLog: ActivityLog | undefined;
  private readonly writeSettings:
    | (() => WriteGateSettings & {
        mcpWriteRateLimitPerHour: number;
        mcpWriteQueueTimeoutMs: number;
      })
    | undefined;
  private readonly writeContext: WriteToolContext | undefined;
  private readonly clock: () => number;
  private readonly rateLimiter = new WriteRateLimiter();
  /**
   * Client name captured during `initialize` and used as the `source:` suffix on
   * activity events recorded for subsequent `tools/call` requests. Falls back
   * to `'mcp'` when no client identifies itself.
   */
  private clientName = 'mcp';

  constructor(deps: McpHandlerDeps) {
    this.registry = deps.toolRegistry;
    this.pluginVersion = deps.pluginVersion;
    this.logger = deps.logger ?? { warn: (msg) => console.warn(`[mcp-handler] ${msg}`) };
    this.activityLog = deps.activityLog;
    this.writeSettings = deps.writeSettings;
    this.writeContext = deps.writeContext;
    this.clock = deps.clock ?? Date.now;
    if (this.writeSettings !== undefined && this.writeContext === undefined) {
      throw new Error(
        'McpHandler: writeSettings was supplied but writeContext is undefined. ' +
          'Pass both to enable Phase 6.7 write-side, or neither to disable.',
      );
    }
  }

  async handle(rawBody: unknown): Promise<JsonRpcResponse> {
    const parsed = parseRequest(rawBody);
    if (!parsed.ok) {
      return parsed.response;
    }
    const req = parsed.request;
    try {
      switch (req.method) {
        case 'initialize':
          return this.onInitialize(req);
        case 'tools/list':
          return this.onToolsList(req);
        case 'tools/call':
          return await this.onToolsCall(req);
        default:
          return errorResponse(
            req.id,
            JSON_RPC_ERROR.METHOD_NOT_FOUND,
            `method '${req.method}' not supported`,
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`internal error in '${req.method}': ${message}`);
      return errorResponse(req.id, JSON_RPC_ERROR.INTERNAL_ERROR, message);
    }
  }

  private onInitialize(req: JsonRpcRequest): JsonRpcResponse {
    // Capture clientInfo.name from the handshake so subsequent activity
    // events can attribute themselves (`source: 'mcp:<client>'`).
    const params = req.params;
    if (params !== null && typeof params === 'object') {
      const obj = params as Record<string, unknown>;
      const clientInfo = obj.clientInfo;
      if (clientInfo !== null && typeof clientInfo === 'object') {
        const name = (clientInfo as Record<string, unknown>).name;
        if (typeof name === 'string' && name.length > 0) {
          this.clientName = `mcp:${name}`;
        }
      }
    }
    return successResponse(req.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'sagittarius',
        version: this.pluginVersion,
      },
    });
  }

  private onToolsList(req: JsonRpcRequest): JsonRpcResponse {
    const exposed = this.currentExposure();
    const tools = mcpToolListFrom(this.registry.definitions(), exposed);
    return successResponse(req.id, { tools });
  }

  private async onToolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params;
    if (params === null || typeof params !== 'object') {
      return errorResponse(
        req.id,
        JSON_RPC_ERROR.INVALID_PARAMS,
        '`params` must be an object',
      );
    }
    const obj = params as Record<string, unknown>;
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
      return errorResponse(
        req.id,
        JSON_RPC_ERROR.INVALID_PARAMS,
        '`params.name` must be a non-empty string',
      );
    }
    const exposed = this.currentExposure();
    if (!isMcpExposed(obj.name, exposed)) {
      // Tool exists in the registry but isn't on the current exposure
      // set (read-only when write-side is off, or unknown name).
      // Either way the client should see the same error so write-tool
      // names aren't enumerable when disabled.
      return errorResponse(
        req.id,
        JSON_RPC_ERROR.METHOD_NOT_FOUND,
        `tool '${obj.name}' not available over MCP`,
      );
    }
    const args = obj.arguments ?? {};
    const toolName = obj.name;
    const isWrite = isMcpWriteTool(toolName);

    if (isWrite) {
      // Phase 6.7 gates (master/high-risk/per-client/path/rate-limit)
      // per ADR-025 D1+D6+D7+D9. These run BEFORE registry.execute so
      // the diff card never even opens on a gate-rejected call.
      const gateError = this.runWriteGates(toolName, args);
      if (gateError !== null) {
        return errorResponse(req.id, JSON_RPC_ERROR.SERVER_ERROR, gateError);
      }
    }

    const result = isWrite
      ? await this.executeWriteCall(toolName, args)
      : await this.executeReadCall(toolName, args);
    if (result.kind === 'error-response') {
      return errorResponse(req.id, JSON_RPC_ERROR.SERVER_ERROR, result.message);
    }
    if (result.kind === 'tool-error') {
      await this.activityLog?.record({
        kind: 'error',
        source: this.clientName,
        message: `mcp tool '${toolName}' failed: ${result.message}`,
      });
      const errorContent: McpToolCallResult = wrapToolResult(
        `tool error: ${result.message}`,
        true,
      );
      return successResponse(req.id, errorContent);
    }
    if (result.kind === 'queued') {
      // Per ADR-025 D2 (c) hybrid — the timeout fired before the user
      // approved. The tool keeps running in the background; when the
      // user eventually responds via the side panel, the transaction
      // commits and emits its own `write.committed` event. We skip
      // the surface-level activity event here so the operator doesn't
      // see a phantom "applied" before the actual apply.
      return successResponse(
        req.id,
        wrapToolResult({ status: 'queued', message: result.message }),
      );
    }

    // Record successful invocation in the activity stream with the
    // `source:` field attributing it to the MCP client. For write
    // tools the `TransactionLog.appendAndPersist` ALSO emits a
    // `write.committed` event (via the Slice 1 source plumbing).
    // We deliberately keep this surface-level event too so read tools
    // are visible in the activity stream and the operator can scan
    // "what did Claude Desktop do today" without joining two streams.
    await this.activityLog?.record({
      kind: 'write.committed',
      source: this.clientName,
      toolName,
      path:
        typeof (args as Record<string, unknown>).path === 'string'
          ? ((args as Record<string, unknown>).path as string)
          : '',
    });
    return successResponse(req.id, wrapToolResult(result.value));
  }

  /**
   * Compute the current exposure set from the supplied `writeSettings`
   * accessor. When no accessor was supplied, exposure is the v0.9.x
   * read-only set.
   */
  private currentExposure(): ReadonlySet<string> {
    if (this.writeSettings === undefined) {
      return mcpExposedToolNames({ writeEnabled: false, highRiskEnabled: false });
    }
    const s = this.writeSettings();
    return mcpExposedToolNames({
      writeEnabled: s.mcpWriteEnabled,
      highRiskEnabled: s.mcpHighRiskToolsEnabled,
    });
  }

  /**
   * Run write-side gates 1-5. Returns `null` on success or a
   * user-actionable error string on first denial.
   */
  private runWriteGates(toolName: string, args: unknown): string | null {
    if (this.writeSettings === undefined) {
      // Defensive: a write tool reached call-dispatch without write
      // settings configured. `currentExposure()` should have made the
      // tool invisible — log and reject.
      this.logger.warn(
        `write tool '${toolName}' invoked without writeSettings configured — rejecting`,
      );
      return 'MCP write-side is not configured on this server.';
    }
    const s = this.writeSettings();
    const verdict = evaluateWriteGate(toolName, args, this.clientName, s);
    if (!verdict.ok) {
      return verdict.reason;
    }
    const rate = this.rateLimiter.tryConsume(this.clock(), s.mcpWriteRateLimitPerHour);
    if (!rate.ok) {
      return rate.reason;
    }
    return null;
  }

  /**
   * Execute a write tool inside a transaction tagged with
   * `source: 'mcp:<client>'` per ADR-025 D5. Implements the D2 (c)
   * hybrid block-then-queue transport: races `registry.execute`
   * against `mcpWriteQueueTimeoutMs`. If exec wins, commits and
   * returns the result; if timeout wins, returns `'queued'` while
   * the tool keeps running in the background — when the user
   * eventually approves/rejects via the side panel, the transaction
   * still commits (or abandons) and the `TransactionLog` emits its
   * own `write.committed` event with `source`.
   *
   * Returns a four-way `ExecuteOutcome`:
   *   `ok`             — tool ran synchronously, transaction committed
   *   `tool-error`     — tool threw; transaction abandoned
   *   `error-response` — infrastructure refused (ctx busy, etc.)
   *   `queued`         — timeout expired; user must respond in panel
   */
  private async executeWriteCall(toolName: string, args: unknown): Promise<ExecuteOutcome> {
    if (this.writeContext === undefined) {
      // Same defensive guard as runWriteGates — should be unreachable.
      return { kind: 'error-response', message: 'MCP write-side has no transaction context.' };
    }
    const writeContext = this.writeContext;
    try {
      writeContext.begin(undefined, this.clientName);
    } catch (err) {
      // The singleton context is open — typically because in-app chat
      // is mid-turn. We don't preempt; surface a clear retry signal.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`write context unavailable for '${toolName}': ${msg}`);
      return {
        kind: 'error-response',
        message:
          'In-app chat is in progress (transaction in flight). ' +
          'Retry the MCP write shortly.',
      };
    }

    // Drive the tool to completion (or background, on timeout). The
    // IIFE wraps in try/catch so this promise NEVER rejects — that
    // matters because after a timeout the MCP handler has already
    // returned 'queued' and any later rejection would be unhandled.
    const execPromise: Promise<SyncExecuteOutcome> = (async () => {
      try {
        const value = await this.registry.execute(toolName, args);
        await writeContext.end();
        return { kind: 'ok', value };
      } catch (err) {
        try {
          writeContext.abandon();
        } catch {
          // abandon() should never throw, but defend against future changes.
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'tool-error', message };
      }
    })();

    const timeoutMs = this.writeSettings?.()?.mcpWriteQueueTimeoutMs ?? 30_000;
    if (timeoutMs <= 0) {
      // Pure-synchronous mode (operator disabled the queue).
      return await execPromise;
    }

    const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      const handle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
      // Don't keep Node alive in tests; no-op in Electron renderer.
      (handle as unknown as { unref?: () => void }).unref?.();
    });
    const winner = await Promise.race([execPromise, timeoutPromise]);
    if (winner === TIMEOUT_SENTINEL) {
      // execPromise keeps running. Attach a logger for any unexpected
      // failure path the IIFE doesn't already swallow (defensive — the
      // IIFE already does, but ts-strict mode wants the .then anyway).
      void execPromise.then((outcome) => {
        if (outcome.kind === 'tool-error') {
          this.logger.warn(
            `queued mcp write '${toolName}' resolved with tool-error: ${outcome.message}`,
          );
        }
      });
      return {
        kind: 'queued',
        message:
          'Proposal queued — review it in the Sagittarius external-proposals panel.',
      };
    }
    return winner;
  }

  /**
   * Execute a read tool. No transaction; structurally simpler than
   * `executeWriteCall` but kept symmetric so the caller dispatches
   * cleanly on `isWrite`.
   */
  private async executeReadCall(toolName: string, args: unknown): Promise<ExecuteOutcome> {
    try {
      const value = await this.registry.execute(toolName, args);
      return { kind: 'ok', value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'tool-error', message };
    }
  }
}

/**
 * Result of an MCP tool dispatch:
 *
 *   `ok`             — tool ran synchronously and returned `value`.
 *   `tool-error`     — tool threw; turn into an MCP `tools/call` result
 *                       with `isError: true` (the SDK convention for
 *                       domain-level tool failures vs. transport bugs).
 *   `error-response` — infrastructure refused (write context unavailable,
 *                       deps missing, etc.); turn into a JSON-RPC error.
 *   `queued`         — ADR-025 D2 (c) timeout expired; the tool keeps
 *                       running in the background until the user
 *                       responds in the side panel. The MCP response
 *                       returns immediately so the LLM client isn't
 *                       blocked.
 */
type SyncExecuteOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'tool-error'; message: string }
  | { kind: 'error-response'; message: string };

type ExecuteOutcome = SyncExecuteOutcome | { kind: 'queued'; message: string };

/** Sentinel for the timeout branch in the race. Unique symbol prevents clashes. */
const TIMEOUT_SENTINEL = Symbol('mcp-write-queue-timeout');
