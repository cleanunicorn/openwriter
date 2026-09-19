import { defineConfig, devices } from '@playwright/test'

const SMOKE_PORT = 4399

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${SMOKE_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // The run starts the app itself: a temp copy of the sample workspace with the fake adapter.
  // Tests that write use the `app` fixture (e2e/fixtures.ts), which starts one server per test.
  webServer: {
    command: `node scripts/e2e-server.ts --port ${SMOKE_PORT}`,
    url: `http://127.0.0.1:${SMOKE_PORT}/api/health`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
