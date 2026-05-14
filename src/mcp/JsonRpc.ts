/**
 * JSON-RPC 2.0 message shapes used by the MCP bridge per
 * [ADR-021](../../docs/2026-05-13-adr-021-phase-6.5-mcp-bridge-plan.md).
 *
 * Hand-rolled because v0.9.0 only needs the request/response cycle —
 * no streaming, no batching, no notifications. The MCP SDK is bundled
 * for type definitions and protocol stability (per D8) but the
 * dispatch is small enough to own directly.
 */

/** JSON-RPC 2.0 standard error codes. */
export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Build a success response with the given id + result. */
export function successResponse(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Build an error response. Always returns a valid JSON-RPC error
 * even when the incoming id was missing — uses null in that case
 * per the spec.
 */
export function errorResponse(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorResponse['error'] =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}

/**
 * Validate that an unknown blob is a well-formed JSON-RPC request.
 * Returns the typed request on success, or null with an error response
 * (which the caller should write back as the HTTP body).
 */
export function parseRequest(
  raw: unknown,
): { ok: true; request: JsonRpcRequest } | { ok: false; response: JsonRpcErrorResponse } {
  if (raw === null || typeof raw !== 'object') {
    return {
      ok: false,
      response: errorResponse(null, JSON_RPC_ERROR.INVALID_REQUEST, 'request must be an object'),
    };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    return {
      ok: false,
      response: errorResponse(
        toRequestId(obj.id),
        JSON_RPC_ERROR.INVALID_REQUEST,
        'jsonrpc must be "2.0"',
      ),
    };
  }
  if (typeof obj.method !== 'string' || obj.method.length === 0) {
    return {
      ok: false,
      response: errorResponse(
        toRequestId(obj.id),
        JSON_RPC_ERROR.INVALID_REQUEST,
        'method must be a non-empty string',
      ),
    };
  }
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: toRequestId(obj.id),
    method: obj.method,
    ...(obj.params !== undefined && { params: obj.params }),
  };
  return { ok: true, request };
}

function toRequestId(value: unknown): JsonRpcRequest['id'] {
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return null;
}
