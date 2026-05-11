/**
 * Path-traversal guard for Phase 4 write tools.
 *
 * Required by [spec §7](../../docs/02_SPEC.md) threat model and
 * [ADR-016 P1](../../docs/2026-05-10-adr-016-phase-4-plan.md): every write tool
 * must validate that its target path stays inside the vault before any
 * `adapter.write()` / `adapter.mkdir()` call.
 *
 * Obsidian's `DataAdapter` already scopes vault-relative paths to the vault
 * root, so a benign caller passing `foo/bar.md` is safe. The risk is a
 * prompt-injected LLM emitting `../../../etc/passwd` (or its macOS
 * equivalent), a leading `/`, a leading `~`, or NULL-byte tricks that some
 * file systems still honor. Without `realpath`/`canonicalize` exposed by
 * Obsidian's adapter, we use a syntactic blocklist — defense in depth, not
 * cryptographic. Tighter checks (e.g. canonical-path comparison) are a
 * Phase 5+ follow-up if the syntactic checks ever prove insufficient.
 *
 * @example
 *   // In a write-tool implementation:
 *   assertInVault(args.path);            // throws on traversal attempts
 *   await adapter.write(args.path, ...); // safe to proceed
 */

export class VaultPathTraversalError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(
      `Refusing to write outside the vault — ${reason}: ${JSON.stringify(path)}. ` +
        `Paths must be vault-relative (no leading '/', '~', '..', NULL bytes, drive letters, or leading whitespace).`,
    );
    this.name = 'VaultPathTraversalError';
  }
}

/**
 * Throw `VaultPathTraversalError` if `path` could escape the vault when
 * passed to `adapter.write()` / `adapter.mkdir()` / `adapter.writeBinary()`.
 *
 * Checks (in order):
 *   1. Empty string
 *   2. Any `..` segment (parent-dir traversal)
 *   3. Leading `/` (absolute path)
 *   4. Leading `~` (home-relative path)
 *   5. NULL byte anywhere
 *   6. Windows drive letter prefix (e.g. `C:\` or `C:/`)
 *   7. Leading whitespace (homoglyph-trick defense)
 *
 * Legitimate paths pass silently:
 *   - `foo.md`, `subdir/foo.md`, `a/b/c.md`
 *   - Unicode names (`émigré.md`, `日本語.md`)
 *   - Names with spaces (`Hello World.md`)
 *   - Names with dots that aren't `..` (`my.note.md`, `.hidden.md`)
 */
export function assertInVault(path: string): void {
  if (path.length === 0) {
    throw new VaultPathTraversalError(path, 'empty path');
  }
  // Match '..' as a full path segment: at start, at end, or between slashes.
  if (/(^|\/)\.\.($|\/)/.test(path)) {
    throw new VaultPathTraversalError(path, "contains '..' segment");
  }
  if (path.startsWith('/')) {
    throw new VaultPathTraversalError(path, 'absolute path (leading /)');
  }
  if (path.startsWith('~')) {
    throw new VaultPathTraversalError(path, 'home-relative path (leading ~)');
  }
  if (path.includes('\0')) {
    throw new VaultPathTraversalError(path, 'NULL byte');
  }
  // Defensive: even on macOS/Linux, the LLM might emit a Windows-style path.
  // Reject `C:\...` and `C:/...` patterns.
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    throw new VaultPathTraversalError(path, 'Windows drive letter');
  }
  if (/^\s/.test(path)) {
    throw new VaultPathTraversalError(path, 'leading whitespace');
  }
}
