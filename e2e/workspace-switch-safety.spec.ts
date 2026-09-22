import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import {
  answer,
  articleHeading,
  blockWith,
  boundingBox,
  dropEventStreams,
  editor,
  notice,
  openArticle,
  openPalette,
  runCommand,
} from './helpers.ts'

// Issue #15: a workspace switch must never lose the writer's text in silence — not in the tab
// that asks for it (R1), not in another tab (R2), not after a dropped event stream (R4) — and it
// happens once per tab (R5). Plus what the writer sees while and after it happens.

const empty = (page: Page) => page.getByText('No article yet')
const moved = (page: Page) => page.getByRole('alert', { name: 'Workspace moved' })
const secondArticle = (app: App, name = 'second') =>
  path.join(app.workspacesDir, name, 'content', 'posts', 'hello-openwrite', 'index.md')

async function typeInto(page: Page, text: string): Promise<void> {
  await blockWith(page, 'Why blocks').getByTestId('block-body').click()
  await expect(editor(page)).toBeVisible()
  await editor(page).pressSequentially(text)
}

async function newWorkspace(page: Page, name = 'second'): Promise<void> {
  await runCommand(page, 'new workspace')
  await answer(page, 'New workspace name', name)
}

/**
 * Hold every save of `page` until the returned function is called, so its text is still unsaved
 * when another tab switches. Resolves once the first save is being held.
 */
async function holdSaves(page: Page): Promise<() => void> {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/docs/article/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await released
    await route.continue()
  })
  return release
}

test('R1: a switch whose save fails does not happen, and the text stays', async ({ page, app }) => {
  let failing = true
  await page.route('**/api/docs/article/**', (route) => {
    if (route.request().method() !== 'PUT' || !failing) return route.continue()
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'the disk is full' }),
    })
  })
  await openArticle(page)
  await typeInto(page, ' — must not be lost')

  await newWorkspace(page)
  await expect(notice(page)).toContainText('could not be saved, so the workspace was not switched')
  // Still in the first workspace, with the text on screen; the second one was never asked for.
  await expect(articleHeading(page)).toBeVisible()
  await expect(blockWith(page, 'must not be lost')).toBeVisible()
  expect(existsSync(path.join(app.workspacesDir, 'second'))).toBe(false)

  // The save retries by itself once the disk is back, and lands where it was typed.
  failing = false
  await expect.poll(() => app.readArticle(), { timeout: 10000 }).toContain('must not be lost')
})

test('R2: another tab keeps its unsaved text when the first one switches, and can go back and save it', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const other = await page.context().newPage()
  await openArticle(other)
  const release = await holdSaves(other)
  const held = other.waitForRequest((request) => request.method() === 'PUT')
  await typeInto(other, ' — typed in the second tab')
  await held

  await newWorkspace(page)
  await expect(empty(page)).toBeVisible()
  // The late save reaches the server now, which is on the other workspace; it is refused there.
  release()

  await expect(moved(other)).toBeVisible()
  await expect(moved(other)).toContainText('Another tab opened the workspace “second”')
  await expect(other.getByText('typed in the second tab')).toBeVisible()
  expect(existsSync(secondArticle(app))).toBe(false)
  expect(app.readArticle()).not.toContain('typed in the second tab')

  await other.getByRole('button', { name: /^Go back to/ }).click()
  await expect(moved(other)).toBeHidden()
  await expect.poll(() => app.readArticle()).toContain('typed in the second tab')
  expect(existsSync(secondArticle(app))).toBe(false)
  // The first tab follows the server back, as it would any switch.
  await expect(articleHeading(page)).toBeVisible()
})

test('R2: the other tab can also discard its unsaved text, but only when asked', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const other = await page.context().newPage()
  await openArticle(other)
  const release = await holdSaves(other)
  const held = other.waitForRequest((request) => request.method() === 'PUT')
  await typeInto(other, ' — thrown away on purpose')
  await held

  await newWorkspace(page)
  await expect(moved(other)).toBeVisible()
  release()
  await other.getByRole('button', { name: /^Discard the changes/ }).click()

  await expect(empty(other)).toBeVisible()
  await expect(moved(other)).toBeHidden()
  expect(app.readArticle()).not.toContain('thrown away on purpose')
})

test('R4: after a dropped event stream, a tab follows the switch it missed', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const other = await page.context().newPage()
  await openArticle(other)

  // The second tab loses its stream and cannot reconnect while the first one switches.
  await other.route('**/api/events', (route) => route.abort())
  await dropEventStreams(app)
  await newWorkspace(page)
  await expect(empty(page)).toBeVisible()
  await other.unroute('**/api/events')

  // It reconnects on its own (EventSource retries), sees the server on another workspace, and
  // follows — it does not re-read "its" article from the new root as an outside change.
  await expect(empty(other)).toBeVisible({ timeout: 15000 })
  await expect(other.getByText('deleted on disk')).toHaveCount(0)
  await expect(other.getByText('changed on disk')).toHaveCount(0)
})

test('R5: the tab that asks for a switch loads the new workspace once', async ({ page }) => {
  await openArticle(page)
  const loads: string[] = []
  page.on('request', (request) => {
    // Adopting a workspace resets the jobs, which asks for the list once; nothing else does while
    // the event stream stays up.
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/jobs')
      loads.push(request.url())
  })
  await newWorkspace(page)
  await expect(empty(page)).toBeVisible()

  // A barrier: a second adoption would clear this new article from the screen again.
  await runCommand(page, 'new article')
  await answer(page, 'Article title', 'Only once')
  await expect(articleHeading(page, 'Only once')).toBeVisible()
  expect(loads).toHaveLength(1)
})

test('a switch shows that it is under way while it waits for a save', async ({ page }) => {
  await page.route('**/api/docs/article/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 2000))
    await route.continue()
  })
  await openArticle(page)
  await typeInto(page, ' — one more line')
  await newWorkspace(page)

  await expect(page.getByRole('status', { name: 'Workspace switch' })).toHaveText(
    'Creating the workspace…',
  )
  await expect(empty(page)).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('status', { name: 'Workspace switch' })).toBeHidden()
})

test('R10: a workspace error is shown when no document is open', async ({ page }) => {
  await openArticle(page)
  await newWorkspace(page)
  await expect(empty(page)).toBeVisible()

  await runCommand(page, 'open workspace…')
  await answer(page, 'Workspace name', 'not-there')
  const shown = page.getByRole('status', { name: 'Notice' })
  await expect(shown).toContainText('Could not open that workspace')
  await expect(shown).toContainText('not-there')
  await shown.getByRole('button', { name: 'Dismiss' }).click()
  await expect(shown).toBeHidden()
})

test('the erase confirmation keeps its warning while the name is typed', async ({ page, app }) => {
  await openArticle(page)
  await newWorkspace(page, 'doomed')
  await expect(empty(page)).toBeVisible()
  await runCommand(page, 'switch to workspace')
  await expect(articleHeading(page)).toBeVisible()

  await runCommand(page, 'delete workspace from disk: doomed')
  const prompt = page.getByRole('combobox', { name: 'Delete doomed from disk' })
  await prompt.fill('doo')
  const warning = page.getByText('It cannot be undone.')
  await expect(warning).toBeVisible()
  await expect(warning).toContainText(path.join(app.workspacesDir, 'doomed'))
  await expect(prompt).toHaveAccessibleDescription(/cannot be undone/)
})

test('a long workspace path in the palette stays inside it', async ({ page, app }) => {
  await page.setViewportSize({ width: 420, height: 800 })
  await openArticle(page)
  // The longest name there is, with no hyphen for a line to break at: its path — the hint that
  // tells workspaces apart — is one long word, like a folder a writer named themselves.
  const long = 'averylongworkspacename'.repeat(3).slice(0, 64)
  await newWorkspace(page, long)
  await expect(empty(page)).toBeVisible()
  await newWorkspace(page)
  await expect(empty(page)).toBeVisible()

  await openPalette(page, 'switch to workspace')
  const palette = await boundingBox(page.getByRole('dialog', { name: 'Command palette' }))
  const option = page.getByRole('option', { name: new RegExp(long) })
  await expect(option).toContainText(path.join(app.workspacesDir, long))
  const box = await boundingBox(option)
  expect(box.x + box.width).toBeLessThanOrEqual(palette.x + palette.width)
  const list = page.getByRole('listbox', { name: 'Commands' })
  expect(await list.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})
