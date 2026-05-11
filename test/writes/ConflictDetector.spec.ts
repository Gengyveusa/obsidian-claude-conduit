import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  sha256Hex,
  snapshot,
  verifyUnchanged,
  WriteConflictError,
} from '../../src/writes/ConflictDetector';

/**
 * In-memory `VaultAdapter` whose `stat.mtime` is set per-file. The tests
 * mutate mtime + content directly to simulate concurrent edits without
 * waiting on real clocks.
 */
class MemAdapter implements VaultAdapter {
  files = new Map<string, { content: string; mtime: number }>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const f = this.files.get(path);
    return f === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(f.content);
  }
  write(path: string, content: string): Promise<void> {
    const existing = this.files.get(path);
    this.files.set(path, { content, mtime: existing ? existing.mtime + 1 : 1 });
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(): Promise<void> {
    throw new Error('unused');
  }
  delete(): Promise<void> {
    throw new Error('unused');
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(path: string): Promise<VaultStat | null> {
    const f = this.files.get(path);
    return Promise.resolve(f === undefined ? null : { mtime: f.mtime, size: f.content.length });
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

describe('sha256Hex', () => {
  it('returns 64 lowercase hex chars', async () => {
    const hex = await sha256Hex('hello');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 of "hello"', async () => {
    expect(await sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('matches the known SHA-256 of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces different hashes for different inputs', async () => {
    const a = await sha256Hex('foo');
    const b = await sha256Hex('bar');
    expect(a).not.toBe(b);
  });
});

describe('snapshot', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
  });

  it('captures mtime and hash of an existing file', async () => {
    adapter.files.set('foo.md', { content: 'hello', mtime: 42 });
    const snap = await snapshot(adapter, 'foo.md');
    expect(snap.mtime).toBe(42);
    expect(snap.hashHex).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('throws when the file does not exist', async () => {
    await expect(snapshot(adapter, 'missing.md')).rejects.toThrow(/does not exist/);
  });
});

describe('verifyUnchanged', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
  });

  it('returns silently when mtime and content match', async () => {
    adapter.files.set('foo.md', { content: 'hello', mtime: 42 });
    const snap = await snapshot(adapter, 'foo.md');

    await expect(verifyUnchanged(adapter, 'foo.md', snap)).resolves.toBeUndefined();
  });

  it('returns silently when mtime drifted but content is unchanged (touch case)', async () => {
    adapter.files.set('foo.md', { content: 'hello', mtime: 42 });
    const snap = await snapshot(adapter, 'foo.md');

    // Simulate `touch`: bump mtime, keep content.
    adapter.files.set('foo.md', { content: 'hello', mtime: 99 });

    await expect(verifyUnchanged(adapter, 'foo.md', snap)).resolves.toBeUndefined();
  });

  it('throws WriteConflictError when content has changed', async () => {
    adapter.files.set('foo.md', { content: 'hello', mtime: 42 });
    const snap = await snapshot(adapter, 'foo.md');

    // Simulate user edit: change content, bump mtime.
    adapter.files.set('foo.md', { content: 'hello, world', mtime: 99 });

    await expect(verifyUnchanged(adapter, 'foo.md', snap)).rejects.toThrow(WriteConflictError);
    await expect(verifyUnchanged(adapter, 'foo.md', snap)).rejects.toThrow(/Write conflict/);
  });

  it('throws WriteConflictError when the file was deleted', async () => {
    adapter.files.set('foo.md', { content: 'hello', mtime: 42 });
    const snap = await snapshot(adapter, 'foo.md');
    adapter.files.delete('foo.md');

    await expect(verifyUnchanged(adapter, 'foo.md', snap)).rejects.toThrow(WriteConflictError);
  });

  it('carries the offending path + snapshot on the error', async () => {
    adapter.files.set('notes.md', { content: 'before', mtime: 10 });
    const snap = await snapshot(adapter, 'notes.md');
    adapter.files.set('notes.md', { content: 'after', mtime: 11 });

    try {
      await verifyUnchanged(adapter, 'notes.md', snap);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WriteConflictError);
      const err = e as WriteConflictError;
      expect(err.path).toBe('notes.md');
      expect(err.before).toEqual(snap);
      expect(err.afterHashHex).toBe(await sha256Hex('after'));
      expect(err.name).toBe('WriteConflictError');
    }
  });

  it('takes the fast path when mtime is unchanged (no re-read)', async () => {
    adapter.files.set('foo.md', { content: 'hello', mtime: 42 });
    const snap = await snapshot(adapter, 'foo.md');

    // Sabotage `read` so it throws if called. mtime-match path must not call it.
    const originalRead = adapter.read.bind(adapter);
    adapter.read = () => Promise.reject(new Error('read should not have been called'));

    await expect(verifyUnchanged(adapter, 'foo.md', snap)).resolves.toBeUndefined();

    adapter.read = originalRead;
  });
});
