import type { App, DataAdapter, ListedFiles, Stat } from 'obsidian';

import type { VaultAdapter, VaultStat } from '../agent/types';

/**
 * Production VaultAdapter wrapping Obsidian's `app.vault.adapter`. Maps the
 * Obsidian DataAdapter surface onto our internal shim so the rest of the
 * code is testable without an Obsidian dependency.
 *
 * @example
 *   const adapter: VaultAdapter = new VaultAdapterImpl(this.app);
 */
export class VaultAdapterImpl implements VaultAdapter {
  private readonly inner: DataAdapter;

  constructor(app: App) {
    this.inner = app.vault.adapter;
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  read(path: string): Promise<string> {
    return this.inner.read(path);
  }

  write(path: string, content: string): Promise<void> {
    return this.inner.write(path, content);
  }

  async mkdir(path: string): Promise<void> {
    if (!(await this.inner.exists(path))) {
      await this.inner.mkdir(path);
    }
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
}
