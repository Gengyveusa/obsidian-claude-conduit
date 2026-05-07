import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';

const banner = `/*
 * Sagittarius — Claude Conduit (obsidian-claude-conduit)
 * Built with esbuild. Source: https://github.com/gengyveusa/obsidian-claude-conduit
 */`;

const prod = process.argv[2] === 'production';

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
    // transformers.js dynamically picks an ONNX runtime by environment.
    // In Obsidian's renderer it uses onnxruntime-web (bundled WASM); the
    // Node-side onnxruntime-node has .node native bindings esbuild can't
    // touch, and `sharp` brings its own native binaries.
    'onnxruntime-node',
    'sharp',
    ...builtins,
  ],
  loader: {
    '.wasm': 'binary',
  },
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
