import { defineConfig, devices } from '@playwright/test'

/** The server is started by scripts/e2e.sh: the production build on wrangler dev, with a fresh database. */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5190',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        timezoneId: 'UTC',
        // The dev shell provides Chromium from nixpkgs; keep its sandbox on.
        launchOptions: {
          ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {}),
          chromiumSandbox: true,
        },
      },
    },
  ],
})
