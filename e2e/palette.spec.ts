import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import { blockWith, briefPath, configPath, mod, openArticle, runCommand } from './helpers.ts'

test('the palette creates a new article and switches between articles', async ({ page, app }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+k`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()

  await palette.getByRole('combobox').fill('new art')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await page.getByRole('combobox', { name: 'Article title' }).fill('Shipping a Block Editor')
  await page.keyboard.press('Enter')

  await expect(
    page.getByRole('heading', { name: 'Shipping a Block Editor', level: 1 }),
  ).toBeVisible()
  expect(existsSync(app.articlePath('shipping-a-block-editor'))).toBe(true)
  expect(existsSync(briefPath(app, 'shipping-a-block-editor'))).toBe(true)

  await runCommand(page, 'open hello')
  await expect(page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })).toBeVisible()
})

test('the palette tells assistive technology which option is active', async ({ page }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+k`)
  const input = page.getByRole('combobox', { name: 'Command palette' })
  const activeOption = async () => {
    const id = await input.getAttribute('aria-activedescendant')
    return id === null ? null : page.locator(`[id="${id}"]`)
  }
  const first = await activeOption()
  await expect(first ?? page.locator('never')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  const second = await activeOption()
  await expect(second ?? page.locator('never')).toHaveAttribute('aria-selected', 'true')
  expect(await second?.getAttribute('id')).not.toBe(await first?.getAttribute('id'))
  // No match, no active descendant.
  await input.fill('zzzz no such command')
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/)
})

test('Escape closes the palette without running anything', async ({ page }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+k`)
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('zen layout: a centred column of about 680px, no toolbar, no sidebar, switchable theme', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const column = await page.getByRole('main').boundingBox()
  expect(column?.width).toBe(680)
  const viewport = page.viewportSize()
  expect(Math.abs((column?.x ?? 0) * 2 + 680 - (viewport?.width ?? 0))).toBeLessThanOrEqual(16)
  await expect(page.getByRole('toolbar')).toHaveCount(0)
  await expect(page.getByRole('complementary')).toHaveCount(0)
  await expect(page.getByRole('navigation')).toHaveCount(0)

  for (const next of ['light', 'dark']) {
    await runCommand(page, 'theme')
    await expect(page.locator('html')).toHaveAttribute('data-theme', next)
  }
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(background).toBe('rgb(25, 25, 25)')
  expect(JSON.parse(readFileSync(configPath(app), 'utf8')).theme).toBe('dark')
})

test('diagrams follow a theme switch instead of keeping the old theme', async ({ page }) => {
  await openArticle(page)
  const diagram = page.getByTestId('diagram').locator('svg')
  const nodeFill = () =>
    diagram
      .locator('.node rect, .node polygon')
      .first()
      .evaluate((node) => getComputedStyle(node).fill)
  const light = await nodeFill()
  await runCommand(page, 'theme')
  await runCommand(page, 'theme')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(async () => expect(await nodeFill()).not.toBe(light)).toPass()
})

test('closing the palette gives the keyboard back to where it was', async ({ page }) => {
  await openArticle(page)
  const heading = blockWith(page, 'Why blocks')
  await heading.hover()
  const handle = heading.getByTestId('drag-handle')
  await handle.focus()
  await page.keyboard.press(`${mod}+k`)
  await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(handle).toBeFocused()
})
