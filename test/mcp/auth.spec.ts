import { describe, expect, it } from 'vitest';

import {
  generateBearerToken,
  hashToken,
  parseBearerHeader,
  timingSafeEqualHex,
  verifyToken,
} from '../../src/mcp/auth';

describe('generateBearerToken', () => {
  it('produces a 43-character base64url string', () => {
    const token = generateBearerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a distinct token on each call', () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  it('produces a 64-character lower-case hex string', async () => {
    const hash = await hashToken('hello');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same input → same hash', async () => {
    const a = await hashToken('the-same-token');
    const b = await hashToken('the-same-token');
    expect(a).toBe(b);
  });

  it('differs across distinct inputs', async () => {
    const a = await hashToken('alpha');
    const b = await hashToken('bravo');
    expect(a).not.toBe(b);
  });

  it('matches a known SHA-256 vector', async () => {
    // SHA-256 of "abc" — RFC 4634 test vector.
    const hash = await hashToken('abc');
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('timingSafeEqualHex', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualHex('deadbeef', 'deadbeef')).toBe(true);
  });

  it('returns false for differing same-length strings', () => {
    expect(timingSafeEqualHex('deadbeef', 'deadbeee')).toBe(false);
  });

  it('returns false on length mismatch without throwing', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualHex('', 'abc')).toBe(false);
  });

  it('returns true on two empty strings (degenerate)', () => {
    expect(timingSafeEqualHex('', '')).toBe(true);
  });
});

describe('verifyToken', () => {
  it('accepts a candidate that hashes to the stored hash', async () => {
    const token = 'sample-bearer-token-1234567890';
    const hash = await hashToken(token);
    expect(await verifyToken(token, hash)).toBe(true);
  });

  it('rejects a wrong candidate', async () => {
    const hash = await hashToken('real-token');
    expect(await verifyToken('wrong-token', hash)).toBe(false);
  });

  it('rejects an empty candidate', async () => {
    const hash = await hashToken('real-token');
    expect(await verifyToken('', hash)).toBe(false);
  });

  it('rejects when stored hash is empty', async () => {
    expect(await verifyToken('whatever', '')).toBe(false);
  });
});

describe('parseBearerHeader', () => {
  it('extracts the token from a well-formed header', () => {
    expect(parseBearerHeader('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseBearerHeader('bearer xyz')).toBe('xyz');
    expect(parseBearerHeader('BEARER xyz')).toBe('xyz');
    expect(parseBearerHeader('BeArEr xyz')).toBe('xyz');
  });

  it('trims surrounding whitespace', () => {
    expect(parseBearerHeader('  Bearer   spaced-token  ')).toBe('spaced-token');
  });

  it('returns null for null / undefined / empty', () => {
    expect(parseBearerHeader(null)).toBeNull();
    expect(parseBearerHeader(undefined)).toBeNull();
    expect(parseBearerHeader('')).toBeNull();
  });

  it('returns null when the scheme is not Bearer', () => {
    expect(parseBearerHeader('Basic abc:def')).toBeNull();
    expect(parseBearerHeader('Token xyz')).toBeNull();
  });

  it('returns null when there is no token after the scheme', () => {
    expect(parseBearerHeader('Bearer')).toBeNull();
    expect(parseBearerHeader('Bearer ')).toBeNull();
  });
});
