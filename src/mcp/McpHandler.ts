import type { ToolRegistry } from '../agent/ToolRegistry';

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
  mcpToolListFrom,
  wrapToolResult,
} from './McpToolAdapter';

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
  /** Test-injectable logger. */
  logger?: { warn: (msg: string) => void };
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

  constructor(deps: McpHandlerDeps) {
    this.registry = deps.toolRegistry;
    this.pluginVersion = deps.pluginVersion;
    this.logger = deps.logger ?? { warn: (msg) => console.warn(`[mcp-handler] ${msg}`) };
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
    const tools = mcpToolListFrom(this.registry.definitions());
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
    if (!isMcpExposed(obj.name)) {
      // Tool exists in the registry but isn't on the v0.9.0 read-only
      // allowlist, OR doesn't exist at all. Either way the client
      // should see the same error so write-tool names aren't enumerable.
      return errorResponse(
        req.id,
        JSON_RPC_ERROR.METHOD_NOT_FOUND,
        `tool '${obj.name}' not available over MCP`,
      );
    }
    const args = obj.arguments ?? {};
    let toolResult: unknown;
    try {
      toolResult = await this.registry.execute(obj.name, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorContent: McpToolCallResult = wrapToolResult(`tool error: ${message}`, true);
      return successResponse(req.id, errorContent);
    }
    return successResponse(req.id, wrapToolResult(toolResult));
  }
}
