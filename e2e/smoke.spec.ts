import { expect, test } from '@playwright/test'

// Runs against the webServer from playwright.config.ts: proves the run starts the app itself.
test('the app starts on the sample workspace', async ({ page, request }) => {
  const health = await request.get('/api/health')
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({ ok: true })

  await page.goto('/')
  await expect(page).toHaveTitle(/openwrite/)
  await expect(page.getByRole('main')).toBeVisible()
})
