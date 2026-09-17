import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  target: 'node20',
  splitting: true,
});
