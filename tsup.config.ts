import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/mcp.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: ['src/index.ts', 'src/mcp.ts'] },
  clean: true,
  sourcemap: false,
  splitting: true,
});
