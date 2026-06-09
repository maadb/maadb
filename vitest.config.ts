import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // CI runners (2-core, Defender active on Windows) run git+sqlite lifecycle
    // suites several times slower than dev machines; vitest's 5s/10s defaults
    // produced spurious timeouts on the first windows-latest run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/server.ts'],
    },
  },
});
