import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';

const banner = `/*
 * Sagittarius — Claude Conduit (obsidian-claude-conduit)
 * Built with esbuild. Source: https://github.com/gengyveusa/obsidian-claude-conduit
 */`;

const prod = process.argv[2] === 'production';

/**
 * Replace `onnxruntime-node` and `sharp` with empty-module stubs at bundle
 * time. Both are Node-only deps that @xenova/transformers tries to load
 * via require(). In Obsidian's Electron renderer the require throws
 * (modules not present in our distribution), and transformers.js's
 * environment detection misinterprets the throw as a hard error rather
 * than the absence-of-Node-runtime signal it's supposed to be.
 *
 * Returning an empty module makes those requires succeed with a no-op
 * object; transformers.js's feature detection then fails cleanly and
 * falls back to onnxruntime-web (which IS bundled per the .wasm loader
 * + sql.js precedent).
 */
const stubNodeOnlyDeps = {
  name: 'stub-node-only-deps',
  setup(build) {
    build.onResolve({ filter: /^(onnxruntime-node|sharp)$/ }, (args) => ({
      path: args.path,
      namespace: 'stubbed',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stubbed' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
  ],
  loader: {
    '.wasm': 'binary',
  },
  plugins: [stubNodeOnlyDeps],
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
}
