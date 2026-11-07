import { defineConfig } from 'vitest/config'

export default defineConfig({
  // `~/` resolves through the tsconfig.json paths.
  resolve: { tsconfigPaths: true },
  test: { include: ['test/**/*.test.ts'], fileParallelism: false },
})
