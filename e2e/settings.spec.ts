import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import { configPath, mod, openArticle } from './helpers.ts'

async function openSettings(page: import('@playwright/test').Page) {
  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('settings')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('form', { name: 'Settings' })).toBeVisible()
}

test('settings are reachable from the palette and stored in .zen/config.json', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await openSettings(page)
  const form = page.getByRole('form', { name: 'Settings' })
  await expect(form).toContainText('--adapter fake')

  // Switching the main agent is a settings change, nothing else.
  await form.getByLabel('Main agent').selectOption('codex')
  await form.getByLabel('Agent for image tasks').selectOption('claude')
  await form.getByLabel('Jobs running at once').fill('5')
  await form.getByLabel('Theme').selectOption('dark')
  await form.getByLabel('codex model').fill('gpt-5-codex')
  await form.getByLabel('claude extra arguments').fill('--max-budget-usd 2')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form.getByRole('status', { name: 'Settings status' })).toHaveText('Saved.')
  await form.getByLabel('Jobs running at once').fill('4')
  await expect(form.getByRole('status', { name: 'Settings status' })).toHaveText('')
  await form.getByLabel('Jobs running at once').fill('5')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form.getByRole('status', { name: 'Settings status' })).toHaveText('Saved.')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  expect(JSON.parse(readFileSync(configPath(app), 'utf8'))).toMatchObject({
    version: 1,
    mainAgent: 'codex',
    taskAgents: { image: 'claude' },
    concurrency: 5,
    theme: 'dark',
    adapters: { codex: { model: 'gpt-5-codex' }, claude: { extraArgs: ['--max-budget-usd', '2'] } },
  })

  await form.getByLabel('Main agent').selectOption('claude')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(() =>
    expect(JSON.parse(readFileSync(configPath(app), 'utf8')).mainAgent).toBe('claude'),
  ).toPass()
})

test('an invalid config file is shown, never overwritten', async ({ page, app }) => {
  writeFileSync(configPath(app), '{ "concurrency": "many" }')
  await openArticle(page)
  await openSettings(page)
  const form = page.getByRole('form', { name: 'Settings' })
  await expect(form.getByRole('alert')).toContainText('concurrency')
  await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(readFileSync(configPath(app), 'utf8')).toBe('{ "concurrency": "many" }')
})

test('the content directory can point outside the workspace, and says so', async ({
  page,
  app,
}) => {
  const outside = path.join(
    app.workspace,
    '..',
    `hugo-site-${path.basename(app.workspace)}`,
    'content',
  )
  mkdirSync(path.join(outside, 'posts', 'from-hugo'), { recursive: true })
  writeFileSync(
    path.join(outside, 'posts', 'from-hugo', 'index.md'),
    '---\ntitle: "From Hugo"\n---\n\nText in the Hugo site.\n',
  )
  await openArticle(page)
  await openSettings(page)
  const form = page.getByRole('form', { name: 'Settings' })
  await form.getByLabel('Content directory').fill(outside)
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(form).toContainText('outside the workspace')
  await form.getByRole('button', { name: 'Close' }).click()

  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('From Hugo')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Text in the Hugo site.')).toBeVisible()
})

test('settings is a modal dialog: focus, Escape, Tab, and no keys reach the document behind it', async ({
  page,
}) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await page.keyboard.press('Escape')
  await openSettings(page)

  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Main agent')).toBeFocused()

  // Enter and undo on a select must not act on the article behind the dialog.
  await page.keyboard.press('Enter')
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByRole('textbox', { name: 'Block editor' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Why blocks edited' })).toBeVisible()

  // Tab stays inside: backwards from the first control lands on the last, and forwards again.
  await dialog.getByRole('button', { name: 'Close' }).focus()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a click on the backdrop closes settings', async ({ page }) => {
  await openArticle(page)
  await openSettings(page)
  await page.getByRole('dialog', { name: 'Settings' }).click({ position: { x: 5, y: 5 } })
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a settings event from outside does not wipe a half-edited form', async ({ page, app }) => {
  await openArticle(page)
  await openSettings(page)
  const form = page.getByRole('form', { name: 'Settings' })
  await form.getByLabel('codex model').fill('half-typed-model')

  // Something else rewrites the config file: the server announces it, the client reloads it.
  const current = JSON.parse(readFileSync(configPath(app), 'utf8'))
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/api/config') && response.request().method() === 'GET',
  )
  await fetch(`${app.url}/api/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...current, concurrency: 7 }),
  })
  await saved
  await expect(form.getByLabel('codex model')).toHaveValue('half-typed-model')
})
