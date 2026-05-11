import { describe, expect, it } from 'vitest';

import {
  assertInVault,
  VaultPathTraversalError,
} from '../../src/agent/validation';

describe('assertInVault', () => {
  describe('accepts legitimate vault-relative paths', () => {
    const ok = [
      'foo.md',
      'subdir/foo.md',
      'a/b/c/d/e.md',
      'Hello World.md',
      'my.note.md',
      '.hidden.md',
      'émigré.md',
      '日本語.md',
      '70-Memory/conversations/2026-05-11/session.md',
      '.obsidian/plugins/obsidian-claude-conduit/index.sqlite',
      'foo (1).md',
      'foo - bar.md',
      // Dots inside segments are fine — only '..' as a segment is bad
      'v1.0.0/notes.md',
      'a.b.c/d.md',
    ];
    for (const path of ok) {
      it(`accepts ${JSON.stringify(path)}`, () => {
        expect(() => assertInVault(path)).not.toThrow();
      });
    }
  });

  describe('rejects empty path', () => {
    it('throws on empty string', () => {
      expect(() => assertInVault('')).toThrow(VaultPathTraversalError);
      expect(() => assertInVault('')).toThrow(/empty path/);
    });
  });

  describe("rejects '..' parent-dir traversal", () => {
    const bad = [
      '..',
      '../foo.md',
      '../../etc/passwd',
      'foo/..',
      'foo/../bar.md',
      'a/b/../../c.md',
      '70-Memory/../../../secrets',
    ];
    for (const path of bad) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        expect(() => assertInVault(path)).toThrow(VaultPathTraversalError);
        expect(() => assertInVault(path)).toThrow(/contains '\.\.'/);
      });
    }
  });

  describe('rejects absolute paths', () => {
    const bad = ['/etc/passwd', '/foo/bar.md', '/'];
    for (const path of bad) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        expect(() => assertInVault(path)).toThrow(VaultPathTraversalError);
        expect(() => assertInVault(path)).toThrow(/absolute path/);
      });
    }
  });

  describe('rejects home-relative paths', () => {
    const bad = ['~', '~/foo.md', '~root/foo.md', '~/Documents/secret.txt'];
    for (const path of bad) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        expect(() => assertInVault(path)).toThrow(VaultPathTraversalError);
        expect(() => assertInVault(path)).toThrow(/home-relative/);
      });
    }
  });

  describe('rejects NULL-byte trickery', () => {
    it('rejects path with embedded NULL', () => {
      expect(() => assertInVault('foo.md\0.png')).toThrow(/NULL byte/);
    });
    it('rejects path starting with NULL', () => {
      expect(() => assertInVault('\0foo.md')).toThrow(/NULL byte/);
    });
  });

  describe('rejects Windows drive letters', () => {
    const bad = ['C:\\foo', 'C:/foo', 'D:\\Users\\thad\\file.txt', 'z:/path'];
    for (const path of bad) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        expect(() => assertInVault(path)).toThrow(/Windows drive letter/);
      });
    }
  });

  describe('rejects leading whitespace', () => {
    const bad = [' foo.md', '\tfoo.md', '\nfoo.md'];
    for (const path of bad) {
      it(`rejects ${JSON.stringify(path)}`, () => {
        expect(() => assertInVault(path)).toThrow(/leading whitespace/);
      });
    }
  });

  describe('error carries useful properties', () => {
    it('exposes the offending path and reason', () => {
      try {
        assertInVault('../etc/passwd');
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(VaultPathTraversalError);
        const err = e as VaultPathTraversalError;
        expect(err.path).toBe('../etc/passwd');
        expect(err.reason).toMatch(/'\.\.'/);
        expect(err.name).toBe('VaultPathTraversalError');
      }
    });
  });
});
