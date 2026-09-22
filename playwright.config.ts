import { execFileSync } from 'node:child_process'
import { defineConfig, devices } from '@playwright/test'

/**
 * The smoke server's port. `OPENWRITE_E2E_PORT` wins; otherwise a free port is picked once, in the
 * runner process, and written back to the environment, so every worker (which loads this file
 * again and inherits the runner's environment) uses the same one. A fixed port made two runs on
 * one machine, e.g. in two checkouts or worktrees, fail to start.
 */
function smokePort(): number {
  const fromEnv = process.env.OPENWRITE_E2E_PORT
  if (fromEnv !== undefined && fromEnv !== '') {
    const port = Number(fromEnv)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`OPENWRITE_E2E_PORT must be a port number, got "${fromEnv}"`)
    }
    return port
  }
  // Synchronous on purpose: the config must export a plain object. The port is free when picked;
  // the only window is between this probe closing and the smoke server binding it.
  const free = execFileSync(
    process.execPath,
    [
      '-e',
      "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port)); s.close() })",
    ],
    { encoding: 'utf8' },
  )
  process.env.OPENWRITE_E2E_PORT = free
  return Number(free)
}

const SMOKE_PORT = smokePort()

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // The run starts the app itself: a temp copy of the sample workspace with the fake adapter.
  // Tests that write use the `app` fixture (e2e/fixtures.ts), which starts one server per test.
  webServer: {
    command: `node scripts/e2e-server.ts --port ${SMOKE_PORT}`,
    url: `http://127.0.0.1:${SMOKE_PORT}/api/health`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
})
