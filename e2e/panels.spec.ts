import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import {
  answer,
  articleHeading,
  ask,
  blockEnd,
  blockTexts,
  blockWith,
  boundingBox,
  configPath,
  editor,
  expectFile,
  expectOneWaiting,
  ghosts,
  jobState,
  keyboardMove,
  mod,
  openArticle,
  pill,
  release,
  runCommand,
  selectWord,
  tray,
  waitingJobs,
} from './helpers.ts'

test('Enter on a focused button activates it instead of entering the document', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper make it louder')
  await expectOneWaiting(app)

  const summary = tray(page).getByRole('button').first()
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(tray(page)).toContainText('fake:upper make it louder')
  await expect(summary).toBeFocused()
})

const leftPanel = (page: Page) => page.getByRole('navigation', { name: 'Files and actions' })
const rightPanel = (page: Page) => page.getByRole('region', { name: 'Agent', exact: true })
const handle = (page: Page, name: 'Files and actions' | 'Agent') =>
  page.getByRole('button', { name, exact: true })
const savedUi = (app: App) => JSON.parse(readFileSync(configPath(app), 'utf8')).ui

test('both panels start closed, toggle from the keyboard, and come back after a reload', async ({
  page,
  app,
}) => {
  // Wide enough for both to dock: narrower, a restored left panel waits for a hand-made opening.
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await expect(leftPanel(page)).toHaveCount(0)
  await expect(rightPanel(page)).toHaveCount(0)
  await expect(handle(page, 'Files and actions')).toHaveAttribute('aria-expanded', 'false')

  await page.keyboard.press(`${mod}+b`)
  await expect(leftPanel(page)).toBeVisible()
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(rightPanel(page)).toBeVisible()
  await expectFile(configPath(app), (text) =>
    expect(JSON.parse(text).ui).toEqual({ leftPanel: true, rightPanel: true }),
  )

  await page.reload()
  await expect(articleHeading(page)).toBeVisible()
  await expect(leftPanel(page)).toBeVisible()
  await expect(rightPanel(page)).toBeVisible()

  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(leftPanel(page)).toHaveCount(0)
  await expect(rightPanel(page)).toHaveCount(0)
  // Four quick toggles: the file ends at the last one, never at an older one.
  await expectFile(configPath(app), (text) =>
    expect(JSON.parse(text).ui).toEqual({ leftPanel: false, rightPanel: false }),
  )
})

test('the edge handles toggle their panel and say whether it is open', async ({ page, app }) => {
  await openArticle(page)
  await handle(page, 'Agent').click()
  await expect(rightPanel(page)).toBeVisible()
  await expect(handle(page, 'Agent')).toHaveAttribute('aria-expanded', 'true')
  await handle(page, 'Files and actions').click()
  await expect(leftPanel(page)).toBeVisible()
  await expect(handle(page, 'Files and actions')).toHaveAttribute('aria-expanded', 'true')

  await handle(page, 'Agent').click()
  await expect(rightPanel(page)).toHaveCount(0)
  await expect(handle(page, 'Agent')).toHaveAttribute('aria-expanded', 'false')
  await expectFile(configPath(app), (text) => expect(JSON.parse(text).ui.rightPanel).toBe(false))
  expect(savedUi(app).leftPanel).toBe(true)
})

test('toggling a panel never takes the keyboard from the block being edited', async ({ page }) => {
  await openArticle(page)
  await page.getByText('This is a sample article.').click()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' one')

  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  await handle(page, 'Files and actions').click()
  await handle(page, 'Agent').click()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type(' two')
  await expect(editor(page)).toContainText(/ one two$/)
})

test('toggling the panels leaves a running job running', async ({ page, app }) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper make it louder')
  const id = await expectOneWaiting(app)

  for (let i = 0; i < 2; i++) {
    await page.keyboard.press(`${mod}+b`)
    await page.keyboard.press(`${mod}+Alt+b`)
  }
  expect(await waitingJobs(app)).toEqual([id])
  expect(await jobState(app, id)).toBe('running')
  await release(app)
  await expect(ghosts(page)).toHaveCount(1)
})

test('docked panels leave the column 680px wide and uncovered', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  const column = await boundingBox(page.getByRole('main'))
  const left = await boundingBox(leftPanel(page))
  const right = await boundingBox(rightPanel(page))
  expect(column.width).toBe(680)
  expect(left.x + left.width).toBeLessThanOrEqual(column.x - 44)
  expect(column.x + column.width).toBeLessThanOrEqual(right.x)
})

test('a block still moves by drag with the left panel docked', async ({ page }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await expect(leftPanel(page)).toBeVisible()
  const first = blockWith(page, 'Why blocks')
  await first.hover()
  const grip = await boundingBox(first.getByTestId('drag-handle'))
  const panel = await boundingBox(leftPanel(page))
  expect(grip.x).toBeGreaterThanOrEqual(panel.x + panel.width)
  const before = await blockTexts(page)
  await keyboardMove(page, first, 'ArrowDown')
  const after = await blockTexts(page)
  expect(after).not.toEqual(before)
  expect([...after].sort()).toEqual([...before].sort())
})

test('the left panel lists the articles, opens and creates one, and marks the current', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  const panel = leftPanel(page)
  const hello = panel.getByRole('button', { name: 'Hello, openwrite' })
  await expect(hello).toHaveAttribute('aria-current', 'page')

  await panel.getByRole('button', { name: 'New article…' }).click()
  await answer(page, 'Article title', 'Panels and Palettes')
  await expect(articleHeading(page, 'Panels and Palettes')).toBeVisible()
  expect(existsSync(app.articlePath('panels-and-palettes'))).toBe(true)
  const created = panel.getByRole('button', { name: 'Panels and Palettes' })
  await expect(created).toHaveAttribute('aria-current', 'page')
  await expect(hello).not.toHaveAttribute('aria-current', 'page')

  await hello.click()
  await expect(articleHeading(page)).toBeVisible()
  await expect(hello).toHaveAttribute('aria-current', 'page')

  await panel.getByRole('button', { name: 'strategy.md' }).click()
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  await panel.getByRole('button', { name: /^Brief/ }).click()
  await expect(page.getByText('brief · hello-openwrite')).toBeVisible()
})

test('the left panel runs actions from the command registry', async ({ page }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  const actions = leftPanel(page).getByRole('region', { name: 'Actions' })
  await expect(actions.getByRole('button', { name: /^Export: standalone HTML/ })).toBeVisible()
  await actions.getByRole('button', { name: 'Settings…' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await actions.getByRole('button', { name: 'All commands' }).click()
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
})

test('the palette shows its commands in labelled groups and the arrows cross them', async ({
  page,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+k`)
  const list = page.getByRole('listbox', { name: 'Commands' })
  for (const name of ['Documents', 'Agent', 'Export', 'Workspace', 'App']) {
    await expect(list.getByRole('group', { name })).toBeVisible()
  }
  const input = page.getByRole('combobox', { name: 'Command palette' })
  const documents = await list.getByRole('group', { name: 'Documents' }).getByRole('option').count()
  for (let i = 0; i < documents; i++) await page.keyboard.press('ArrowDown')
  const active = await input.getAttribute('aria-activedescendant')
  await expect(
    list.getByRole('group', { name: 'Agent' }).getByRole('option').first(),
  ).toHaveAttribute('id', active ?? '')
})

test('the keyboard reaches a panel and Escape hands it back without closing a docked panel', async ({
  page,
}) => {
  await openArticle(page)
  await handle(page, 'Files and actions').focus()
  await page.keyboard.press('Enter')
  await expect(leftPanel(page)).toBeVisible()
  await expect(handle(page, 'Files and actions')).toBeFocused()

  await page.keyboard.press('Tab')
  await expect(leftPanel(page).getByRole('button').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(handle(page, 'Files and actions')).toBeFocused()
  await expect(leftPanel(page)).toBeVisible()
})

test('Escape in a block commits it and leaves the panels alone; in Settings it closes only Settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  await page.getByText('This is a sample article.').click()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveCount(0)
  await expect(leftPanel(page)).toBeVisible()
  await expect(rightPanel(page)).toBeVisible()

  await leftPanel(page).getByRole('button', { name: 'Settings…' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await expect(leftPanel(page)).toBeVisible()
  await expect(rightPanel(page)).toBeVisible()
})

test('on a narrow window the left panel is a drawer that Escape, a pick or a click away closes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openArticle(page)
  await runCommand(page, 'go to files and actions')
  await expect(leftPanel(page)).toHaveAttribute('data-layout', 'overlay')
  await expect(leftPanel(page).getByRole('button').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(leftPanel(page)).toHaveCount(0)

  await page.keyboard.press(`${mod}+b`)
  await expect(leftPanel(page)).toBeVisible()
  await page.getByRole('main').click({ position: { x: 600, y: 10 } })
  await expect(leftPanel(page)).toHaveCount(0)

  await page.keyboard.press(`${mod}+b`)
  await leftPanel(page).getByRole('button', { name: 'strategy.md' }).click()
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  await expect(leftPanel(page)).toHaveCount(0)
})

test('a panel restored in a narrow window never comes back over the text', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await expectFile(configPath(app), (text) => expect(JSON.parse(text).ui.leftPanel).toBe(true))
  await page.setViewportSize({ width: 900, height: 900 })
  await page.reload()
  await expect(articleHeading(page)).toBeVisible()
  await expect(leftPanel(page)).toHaveCount(0)
  await expect(handle(page, 'Files and actions')).toHaveAttribute('aria-expanded', 'false')
})

for (const width of [1500, 1280, 900, 390]) {
  test(`with both panels open at ${width}px the column keeps its width and nothing docked covers it`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await openArticle(page)
    await page.keyboard.press(`${mod}+Alt+b`)
    await page.keyboard.press(`${mod}+b`)
    await expect(rightPanel(page)).toBeVisible()
    const column = await boundingBox(page.getByRole('main'))
    expect(column.width).toBeGreaterThanOrEqual(Math.min(680, width - 96))

    const right = await boundingBox(rightPanel(page))
    const beside = column.x + column.width <= right.x
    const below = column.y + column.height <= right.y
    expect(beside || below).toBe(true)
    expect(await rightPanel(page).getAttribute('data-layout')).toBe(
      width >= 1156 ? 'docked' : 'stacked',
    )
    const left = leftPanel(page)
    const layout = await left.getAttribute('data-layout')
    expect(layout).toBe(width >= 1436 ? 'docked' : 'overlay')
    if (layout === 'docked') {
      const box = await boundingBox(left)
      expect(box.x + box.width).toBeLessThanOrEqual(column.x)
    }
  })
}

test('"Go to agent" brings a stacked agent panel into view and into the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await openArticle(page)
  await runCommand(page, 'go to agent')
  await expect(rightPanel(page)).toHaveAttribute('data-layout', 'stacked')
  await expect(rightPanel(page)).toBeInViewport()
  await expect(page.getByRole('button', { name: /Draft brief from my notes/ })).toBeFocused()
})

test('config writes land in order even when an earlier one is slow', async ({ page, app }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  // Hold the first save on its way to the server; a second toggle happens meanwhile.
  let releaseFirst = () => {}
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let puts = 0
  await page.route('**/api/config', async (route) => {
    // Return from the handler at once: Playwright runs the next request's handler only then.
    if (route.request().method() === 'PUT' && ++puts === 1)
      void firstHeld.then(() => route.continue())
    else await route.continue()
  })
  let answered = 0
  page.on('response', (response) => {
    if (response.url().endsWith('/api/config') && response.request().method() === 'PUT')
      answered += 1
  })
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(rightPanel(page)).toBeVisible()
  releaseFirst()
  // Both saves have landed; the older one must not have landed last.
  await expect.poll(() => answered).toBe(2)
  expect(savedUi(app)).toEqual({ leftPanel: true, rightPanel: true })
})

test('a prompt pill goes away when the left panel opens another document', async ({ page }) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await page.keyboard.press(`${mod}+b`)
  await leftPanel(page).getByRole('button', { name: 'strategy.md' }).click()
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  await expect(pill(page)).toHaveCount(0)

  // Back on the article, the old pill does not come back.
  await leftPanel(page).getByRole('button', { name: 'Hello, openwrite' }).click()
  await expect(articleHeading(page)).toBeVisible()
  await expect(pill(page)).toHaveCount(0)
})
