import type { VaultAdapter } from '../agent/types';

/**
 * Read/write the Sagittarius SQLite index file via the VaultAdapter
 * binary I/O. Path is typically
 * `.obsidian/plugins/obsidian-claude-conduit/index.sqlite` per the
 * embedding contract §3.
 *
 * @example
 *   const persistence = new IndexPersistence(adapter, '.obsidian/plugins/obsidian-claude-conduit/index.sqlite');
 *   const buffer = await persistence.load();
 *   const engine = await SqliteEngine.open({ buffer, writerVersion: '0.1.0' });
 *   // ... insert chunks ...
 *   await persistence.save(engine.export());
 */
export class IndexPersistence {
  constructor(
    private readonly adapter: VaultAdapter,
    private readonly path: string,
  ) {}

  /** True if a persisted index file exists at this path. */
  exists(): Promise<boolean> {
    return this.adapter.exists(this.path);
  }

  /**
   * Load the index file as a Uint8Array, or undefined if it doesn't
   * exist. Suitable for passing directly to `SqliteEngine.open({ buffer })`.
   */
  async load(): Promise<Uint8Array | undefined> {
    if (!(await this.adapter.exists(this.path))) {
      return undefined;
    }
    const buffer = await this.adapter.readBinary(this.path);
    return new Uint8Array(buffer);
  }

  /**
   * Persist a Uint8Array to disk, creating the parent folder if needed.
   * Copies into a fresh ArrayBuffer to avoid SharedArrayBuffer ambiguity
   * at the adapter boundary.
   */
  async save(data: Uint8Array): Promise<void> {
    const folder = parentFolder(this.path);
    if (folder.length > 0) {
      await this.adapter.mkdir(folder);
    }
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    await this.adapter.writeBinary(this.path, ab);
  }
}

function parentFolder(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '';
}
