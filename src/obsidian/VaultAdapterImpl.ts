import type { App, DataAdapter, ListedFiles, Stat } from 'obsidian';

import type { VaultAdapter, VaultStat } from '../agent/types';

/**
 * Production VaultAdapter wrapping Obsidian's `app.vault.adapter`. Maps the
 * Obsidian DataAdapter surface onto our internal shim so the rest of the
 * code is testable without an Obsidian dependency.
 *
 * v0.2.6: `write()` and `writeBinary()` auto-mkdir the parent dir before
 * delegating. Obsidian's raw `DataAdapter.write()` throws `ENOENT` if any
 * intermediate folder is missing, so prior to v0.2.6 every caller had to
 * remember to `mkdir(parent)` first — a footgun for Phase 4's 9 write
 * tools. See ADR-015.
 *
 * @example
 *   const adapter: VaultAdapter = new VaultAdapterImpl(this.app);
 */
export class VaultAdapterImpl implements VaultAdapter {
  private readonly inner: DataAdapter;

  constructor(private readonly app: App) {
    this.inner = app.vault.adapter;
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  read(path: string): Promise<string> {
    return this.inner.read(path);
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.inner.readBinary(path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureParentDir(path);
    await this.inner.write(path, content);
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    await this.ensureParentDir(path);
    await this.inner.writeBinary(path, content);
  }

  async mkdir(path: string): Promise<void> {
    if (!(await this.inner.exists(path))) {
      await this.inner.mkdir(path);
    }
  }

  /**
   * Delete a file. Wraps `DataAdapter.remove()`. Used by the v0.4.0
   * `undo_last_transaction` command to reverse `create_note` proposals.
   */
  delete(path: string): Promise<void> {
    return this.inner.remove(path);
  }

  /**
   * Move or rename a file via `app.fileManager.renameFile()` — Obsidian's
   * metadata-cache-aware op that rewrites every wikilink across the vault
   * to point at the new location. Used by v0.4.1's `move_note` and
   * `rename_note` tools.
   *
   * Throws if `oldPath` doesn't resolve to a `TFile` (folders, missing,
   * or null cases) or if `newPath` already exists.
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (file === null) {
      throw new Error(`VaultAdapterImpl.renameFile: ${oldPath} does not exist.`);
    }
    // Duck-type TFile vs TFolder without importing `TFile` at runtime —
    // obsidian.d.ts ships type definitions only, no JS module to bind
    // `instanceof` against at test time. `extension` is present on TFile
    // but not TFolder.
    if (!('extension' in file)) {
      throw new Error(
        `VaultAdapterImpl.renameFile: ${oldPath} is not a file (probably a folder). ` +
          'Use a different tool to move folders.',
      );
    }
    if (await this.inner.exists(newPath)) {
      throw new Error(
        `VaultAdapterImpl.renameFile: refusing to clobber existing ${newPath}.`,
      );
    }
    // Auto-mkdir the parent of newPath so the rename doesn't fail on a
    // missing folder (mirrors the write() contract from v0.2.6 / ADR-015).
    await this.ensureParentDir(newPath);
    await this.app.fileManager.renameFile(file, newPath);
  }

  async stat(path: string): Promise<VaultStat | null> {
    const stat: Stat | null = await this.inner.stat(path);
    if (!stat) {
      return null;
    }
    return {
      mtime: stat.mtime / 1000, // Obsidian gives ms; contract wants epoch seconds
      size: stat.size,
    };
  }

  async list(folderPath: string): Promise<{ files: string[]; folders: string[] }> {
    const listed: ListedFiles = await this.inner.list(folderPath);
    return { files: listed.files, folders: listed.folders };
  }

  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve(this.app.vault.getMarkdownFiles().map((f) => f.path));
  }

  /**
   * Derive the parent dir of a vault-relative path and ensure it exists.
   * Obsidian's `DataAdapter.mkdir` is recursive (verified per ADR-015), so
   * one call covers any depth. Skips when the path is at root.
   */
  private async ensureParentDir(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) {
      return;
    }
    const parent = path.slice(0, lastSlash);
    if (!(await this.inner.exists(parent))) {
      await this.inner.mkdir(parent);
    }
  }
}
