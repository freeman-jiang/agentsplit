import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // The differential tests load the current app's code from ../src.
    alias: {
      '@/': fileURLToPath(new URL('../src/', import.meta.url)),
      '~/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], fileParallelism: false },
})
