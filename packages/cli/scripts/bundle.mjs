import { build } from 'esbuild';

// Keep the SDK/declarations emitted by tsc; replace only the cold CLI entry. One
// React/Ink instance stays external, while bundling eliminates the CLI's hundreds
// of dependency resolutions. CommonJS dependencies retain Node's native require.
await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: true,
  external: ['ink', 'react', 'react/*'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
