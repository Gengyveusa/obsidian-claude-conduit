import { beforeEach, describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import {
  findTagForCommitInPackedRefs,
  readHeadSha,
  resolveRefFromPackedRefs,
  resolveTagForCommit,
  vaultHasGit,
} from '../../src/timetravel/git';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  read(path: string): Promise<string> {
    const v = this.files.get(path);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(v);
  }
  write(): Promise<void> {
    throw new Error('unused');
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
  renameFile(): Promise<void> {
    throw new Error('unused');
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }
}

const SHA_A = 'a1b2c3d4e5f6789012345678901234567890abcd';
const SHA_B = 'b2c3d4e5f6789012345678901234567890abcdef';

describe('vaultHasGit', () => {
  it('returns false when .git/HEAD is missing', async () => {
    const a = new MemAdapter();
    expect(await vaultHasGit(a)).toBe(false);
  });

  it('returns true when .git/HEAD exists', async () => {
    const a = new MemAdapter();
    a.files.set('.git/HEAD', 'ref: refs/heads/main\n');
    expect(await vaultHasGit(a)).toBe(true);
  });
});

describe('readHeadSha', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
  });

  it('returns null when .git/HEAD is missing', async () => {
    expect(await readHeadSha(adapter)).toBeNull();
  });

  it('returns the SHA when HEAD is detached (bare hex)', async () => {
    adapter.files.set('.git/HEAD', `${SHA_A}\n`);
    expect(await readHeadSha(adapter)).toBe(SHA_A);
  });

  it('lowercases an uppercase detached HEAD', async () => {
    adapter.files.set('.git/HEAD', SHA_A.toUpperCase());
    expect(await readHeadSha(adapter)).toBe(SHA_A);
  });

  it("resolves a branch ref via the loose-ref file", async () => {
    adapter.files.set('.git/HEAD', 'ref: refs/heads/main\n');
    adapter.files.set('.git/refs/heads/main', `${SHA_A}\n`);
    expect(await readHeadSha(adapter)).toBe(SHA_A);
  });

  it('falls back to packed-refs when the loose ref is absent', async () => {
    adapter.files.set('.git/HEAD', 'ref: refs/heads/main\n');
    adapter.files.set(
      '.git/packed-refs',
      [
        '# pack-refs with: peeled fully-peeled sorted',
        `${SHA_B} refs/heads/main`,
        `${SHA_A} refs/tags/v1.0.0`,
        '^c3d4e5f6789012345678901234567890abcdef12',
      ].join('\n'),
    );
    expect(await readHeadSha(adapter)).toBe(SHA_B);
  });

  it('returns null when HEAD points at an unresolvable ref', async () => {
    adapter.files.set('.git/HEAD', 'ref: refs/heads/missing-branch\n');
    expect(await readHeadSha(adapter)).toBeNull();
  });

  it('returns null when HEAD contains garbage', async () => {
    adapter.files.set('.git/HEAD', 'not a ref and not a sha\n');
    expect(await readHeadSha(adapter)).toBeNull();
  });

  it('returns null when the loose ref contains garbage', async () => {
    adapter.files.set('.git/HEAD', 'ref: refs/heads/main\n');
    adapter.files.set('.git/refs/heads/main', 'not a sha\n');
    // No packed-refs as fallback — overall returns null.
    expect(await readHeadSha(adapter)).toBeNull();
  });
});

describe('resolveRefFromPackedRefs', () => {
  it('finds the SHA for a given ref name', () => {
    const packed = [
      '# header comment',
      `${SHA_A} refs/heads/main`,
      `${SHA_B} refs/tags/v1.5.0`,
    ].join('\n');
    expect(resolveRefFromPackedRefs(packed, 'refs/heads/main')).toBe(SHA_A);
    expect(resolveRefFromPackedRefs(packed, 'refs/tags/v1.5.0')).toBe(SHA_B);
  });

  it('skips peel markers (^<sha> lines)', () => {
    const packed = [
      `${SHA_A} refs/tags/v1.0.0`,
      `^${SHA_B}`,
    ].join('\n');
    // refs/tags/v1.0.0 → SHA_A; the peel ^SHA_B is for the tag's
    // underlying commit but we treat the tag's own SHA as the result.
    expect(resolveRefFromPackedRefs(packed, 'refs/tags/v1.0.0')).toBe(SHA_A);
  });

  it('skips comment lines + empty lines', () => {
    const packed = [
      '# pack-refs with: peeled fully-peeled sorted',
      '',
      `${SHA_A} refs/heads/main`,
      '',
    ].join('\n');
    expect(resolveRefFromPackedRefs(packed, 'refs/heads/main')).toBe(SHA_A);
  });

  it('returns null when the ref is not present', () => {
    const packed = `${SHA_A} refs/heads/main\n`;
    expect(resolveRefFromPackedRefs(packed, 'refs/heads/other')).toBeNull();
  });

  it('rejects malformed SHA values', () => {
    const packed = 'not-a-sha refs/heads/main\n';
    expect(resolveRefFromPackedRefs(packed, 'refs/heads/main')).toBeNull();
  });
});

describe('findTagForCommitInPackedRefs (Phase 16 / ADR-037 D4)', () => {
  it('matches a lightweight tag whose target IS the commit', () => {
    const packed = [
      '# pack-refs with: peeled fully-peeled sorted',
      `${SHA_A} refs/heads/main`,
      `${SHA_B} refs/tags/v1.5.0`,
    ].join('\n');
    expect(findTagForCommitInPackedRefs(packed, SHA_B)).toBe('v1.5.0');
  });

  it('matches an annotated tag via its peel marker', () => {
    const tagObjSha = 'cccccc1111111111111111111111111111111111';
    const commitSha = 'aaaaaa2222222222222222222222222222222222';
    const packed = [
      `${tagObjSha} refs/tags/v2.0.0`,
      `^${commitSha}`,
    ].join('\n');
    expect(findTagForCommitInPackedRefs(packed, commitSha)).toBe('v2.0.0');
    // The tag-object SHA itself is NOT considered a match for the
    // commit — only the peeled commit-sha matches.
    expect(findTagForCommitInPackedRefs(packed, tagObjSha)).toBe('v2.0.0');
  });

  it('returns null for an untagged commit', () => {
    const packed = [`${SHA_A} refs/heads/main`, `${SHA_B} refs/tags/v1.0.0`].join('\n');
    expect(findTagForCommitInPackedRefs(packed, 'feedface' + '0'.repeat(32))).toBeNull();
  });

  it('returns null when packed-refs only has branches', () => {
    const packed = `${SHA_A} refs/heads/main\n`;
    expect(findTagForCommitInPackedRefs(packed, SHA_A)).toBeNull();
  });

  it('case-insensitive on commit SHA input', () => {
    const upper = SHA_A.toUpperCase();
    const packed = `${SHA_A} refs/tags/v9.9.9\n`;
    expect(findTagForCommitInPackedRefs(packed, upper)).toBe('v9.9.9');
  });
});

describe('resolveTagForCommit (Phase 16 / ADR-037 D4)', () => {
  let adapter: MemAdapter;

  beforeEach(() => {
    adapter = new MemAdapter();
  });

  it('returns the tag name from packed-refs', async () => {
    adapter.files.set(
      '.git/packed-refs',
      `${SHA_B} refs/tags/v1.5.0\n`,
    );
    expect(await resolveTagForCommit(adapter, SHA_B)).toBe('v1.5.0');
  });

  it('returns null when packed-refs is absent', async () => {
    // No `.git/packed-refs` written.
    expect(await resolveTagForCommit(adapter, SHA_A)).toBeNull();
  });

  it('returns null for an unparseable commit SHA', async () => {
    expect(await resolveTagForCommit(adapter, 'not-a-sha')).toBeNull();
  });

  it('returns null for an untagged commit', async () => {
    adapter.files.set('.git/packed-refs', `${SHA_A} refs/heads/main\n`);
    expect(await resolveTagForCommit(adapter, SHA_A)).toBeNull();
  });
});
