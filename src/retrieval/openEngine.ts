/**
 * Production-only entry point that injects esbuild's base64-inlined sql.js
 * wasm into SqliteEngine. Tests do NOT import this module; they call
 * SqliteEngine.open directly and let sql.js's filesystem fallback locate
 * the wasm under node_modules.
 *
 * Splitting this out keeps the test path bundler-independent and isolates
 * the ~660 KB wasm binary (~880 KB base64-inlined into main.js) per ADR-011.
 */
import wasmBinary from 'sql.js/dist/sql-wasm.wasm';
import { SqliteEngine, type SqliteOpenOptions } from './SqliteEngine';

// esbuild's binary loader returns the wasm as a Uint8Array; sql.js / emscripten
// types want a strict ArrayBuffer. Copy once on module load (~660 KB, sub-ms)
// to avoid SharedArrayBuffer ambiguity on .buffer.
const WASM_BUFFER = new ArrayBuffer(wasmBinary.byteLength);
new Uint8Array(WASM_BUFFER).set(wasmBinary);

/**
 * Open a SqliteEngine using the bundled sql.js wasm. Strip-replace for
 * SqliteEngine.open in production code paths.
 * @example const engine = await openSqliteEngine({ writerVersion: this.manifest.version });
 */
export async function openSqliteEngine(
  opts: Omit<SqliteOpenOptions, 'wasmBinary'>,
): Promise<SqliteEngine> {
  return SqliteEngine.open({ ...opts, wasmBinary: WASM_BUFFER });
}
