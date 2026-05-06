/**
 * Module declaration for esbuild's binary loader.
 *
 * `loader: { '.wasm': 'binary' }` in esbuild.config.mjs makes
 * `import x from 'foo.wasm'` resolve to a `Uint8Array`. TypeScript needs
 * this declaration to know the import is valid.
 */
declare module '*.wasm' {
  const content: Uint8Array;
  export default content;
}
