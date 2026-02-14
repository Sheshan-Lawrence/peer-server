import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 15000,
    pool: 'forks',
    sequence: {
      concurrent: false,
    },
  },
});
