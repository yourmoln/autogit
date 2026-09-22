import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // The shared workspace package is TypeScript source, so it has to be bundled
  // instead of being kept as an external import.
  noExternal: ['@autogit/shared'],
  // Keep Node builtins (especially `node:sqlite`) as external specifiers.
  external: ['node:*'],
  skipNodeModulesBundle: true,
});
