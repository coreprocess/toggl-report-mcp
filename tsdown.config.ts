/** tsdown build configuration: bundle the stdio server into a single executable ESM file. */
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  clean: true,
  dts: false,
  fixedExtension: false,
});
