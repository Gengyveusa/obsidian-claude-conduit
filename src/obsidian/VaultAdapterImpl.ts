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
