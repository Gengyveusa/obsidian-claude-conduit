import { describe, expect, it } from 'vitest';

import {
  JSON_RPC_ERROR,
  errorResponse,
  parseRequest,
  successResponse,
} from '../../src/mcp/JsonRpc';

describe('successResponse', () => {
  it('attaches result and id', () => {
    expect(successResponse(7, { ok: true })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { ok: true },
    });
  });

  it('preserves string ids and null', () => {
    expect(successResponse('abc', 1).id).toBe('abc');
    expect(successResponse(null, 1).id).toBeNull();
  });
});

describe('errorResponse', () => {
  it('builds a minimal error', () => {
    expect(errorResponse(1, JSON_RPC_ERROR.METHOD_NOT_FOUND, 'no such method')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: 'no such method' },
    });
  });

  it('includes data when provided', () => {
    const r = errorResponse(1, JSON_RPC_ERROR.INVALID_PARAMS, 'bad', { field: 'name' });
    expect(r.error).toEqual({
      code: JSON_RPC_ERROR.INVALID_PARAMS,
      message: 'bad',
      data: { field: 'name' },
    });
  });
});

describe('parseRequest', () => {
  it('accepts a well-formed request', () => {
    const r = parseRequest({ jsonrpc: '2.0', id: 1, method: 'foo', params: { x: 1 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request).toEqual({ jsonrpc: '2.0', id: 1, method: 'foo', params: { x: 1 } });
    }
  });

  it('omits params when not provided', () => {
    const r = parseRequest({ jsonrpc: '2.0', id: 1, method: 'noop' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.params).toBeUndefined();
    }
  });

  it('rejects non-object body', () => {
    const r = parseRequest('not an object');
    expect(r.ok).toBe(false);
  });

  it('rejects wrong jsonrpc version', () => {
    const r = parseRequest({ jsonrpc: '1.0', id: 1, method: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rejects missing method', () => {
    const r = parseRequest({ jsonrpc: '2.0', id: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects empty method string', () => {
    const r = parseRequest({ jsonrpc: '2.0', id: 1, method: '' });
    expect(r.ok).toBe(false);
  });

  it('coerces non-string-non-number id to null', () => {
    const r = parseRequest({ jsonrpc: '2.0', id: { weird: true }, method: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.id).toBeNull();
    }
  });

  it('returns an error response with the parsed id if available', () => {
    const r = parseRequest({ jsonrpc: 'wrong', id: 99, method: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.id).toBe(99);
    }
  });
});
