import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['tests/performance/*.baseline.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
} });
