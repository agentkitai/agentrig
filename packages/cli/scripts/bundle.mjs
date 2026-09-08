import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

// Keep the SDK/declarations emitted by tsc; replace only the cold CLI entry. One
// React/Ink graph is bundled once; lazy modules remain split (including optional
// devtools). Yoga's location-sensitive WASM package, Ink's optional devtools peer,
// and the lazy TypeScript parser stay external. TypeScript inspects its own
// __filename/__dirname and must execute through native CJS interop, not ESM splitting.
export const cliBundleOptions = {
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: true,
  external: ['yoga-layout', 'react-devtools-core', 'typescript'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
};
if (process.argv[1] && (await realpath(fileURLToPath(import.meta.url))) === (await realpath(process.argv[1]))) await build(cliBundleOptions);
