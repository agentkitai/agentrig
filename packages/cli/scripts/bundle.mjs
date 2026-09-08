import { build } from 'esbuild';

// Keep the SDK/declarations emitted by tsc; replace only the cold CLI entry. One
// React/Ink graph is bundled once; lazy modules remain split (including optional
// devtools and the TypeScript parser). Only Yoga's location-sensitive WASM package
// and Ink's optional devtools peer stay external. CommonJS retains native require.
await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: true,
  external: ['yoga-layout', 'react-devtools-core'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
