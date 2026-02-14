import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/react/**/*.test.tsx'],
    testTimeout: 10000,
  },
});
