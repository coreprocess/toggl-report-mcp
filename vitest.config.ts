/** Vitest configuration: node-runtime tests colocated in __tests__ folders. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.node.test.ts'],
    environment: 'node',
  },
});
