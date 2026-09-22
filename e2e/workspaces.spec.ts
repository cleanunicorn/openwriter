import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type App, expect, test } from './fixtures.ts'
import {
  answer,
  articleHeading,
  blockWith,
  editor,
  notice,
  openArticle,
  openPalette,
  runCommand,
} from './helpers.ts'

const empty = (page: import('@playwright/test').Page) => page.getByText('No article yet')

/** Make a second workspace through the palette and end up in it. */
async function createSecond(
  page: import('@playwright/test').Page,
  app: App,
  name = 'second',
): Promise<string> {
  const root = path.join(app.workspacesDir, name)
  await runCommand(page, 'new workspace')
  await answer(page, 'New workspace name', name)
  await expect(empty(page)).toBeVisible()
  return root
}

test('the palette creates another workspace, opens it, and comes back', async ({ page, app }) => {
  await openArticle(page)

  const second = await createSecond(page, app)
  expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
  expect(existsSync(path.join(second, 'content', 'posts'))).toBe(true)
  expect(existsSync(path.join(second, 'sources'))).toBe(true)

  // The article of the workspace we left is not on screen, and its files are untouched.
  await expect(articleHeading(page)).toBeHidden()
  expect(existsSync(app.articlePath())).toBe(true)

  await runCommand(page, `switch to workspace: ${path.basename(app.workspace)}`)
  await expect(articleHeading(page)).toBeVisible()
})

test('a new workspace is a name in the workspaces folder, never a path', async ({ page, app }) => {
  await openArticle(page)
  for (const typed of ['/', '../escape', path.join(path.dirname(app.workspacesDir), 'elsewhere')]) {
    await runCommand(page, 'new workspace')
    await answer(page, 'New workspace name', typed)
    await expect(notice(page)).toContainText('lowercase letters, digits and hyphens')
  }
  // Nothing was scaffolded anywhere, and the writer is still in the workspace they were in.
  expect(existsSync(path.join(path.dirname(app.workspacesDir), 'escape'))).toBe(false)
  expect(existsSync(path.join(path.dirname(app.workspacesDir), 'elsewhere'))).toBe(false)
  await expect(articleHeading(page)).toBeVisible()
})

test('an article written in one workspace does not follow the writer to the next', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await createSecond(page, app)

  // Same slug, different workspace: the new one's article is its own, not the old one's text.
  await runCommand(page, 'new article')
  await answer(page, 'Article title', 'Hello, openwrite')
  await expect(articleHeading(page)).toBeVisible()
  await expect(blockWith(page, 'Why blocks')).toHaveCount(0)
  expect(readFileSync(app.articlePath(), 'utf8')).toContain('## Why blocks')
})

test('switching waits for the save it has not finished yet', async ({ page, app }) => {
  // Every save is given five seconds of latency, which is long enough that one is always still
  // in flight when the switch is asked for. That forces the order instead of racing it: if the
  // switch did not wait, its request would reach the server while the save was outstanding, and
  // the writer's last sentence would arrive after the root had moved — landing in the other
  // workspace, or nowhere. `order` records what the server was asked to do, in order.
  const order: string[] = []
  await page.route('**/api/docs/article/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 5000))
    order.push('save')
    await route.continue()
  })
  // Watched, not routed: a route handler would block the other requests of this page while it
  // slept, which would impose the very order this test is here to observe.
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/workspaces')) {
      order.push('switch')
    }
  })

  await openArticle(page)
  await blockWith(page, 'Why blocks').getByTestId('block-body').click()
  await expect(editor(page)).toBeVisible()
  await editor(page).pressSequentially(' — and a late thought')

  const second = path.join(app.workspacesDir, 'second')
  await runCommand(page, 'new workspace')
  await answer(page, 'New workspace name', 'second')
  // Longer than the latency above: the switch is *supposed* to be waiting for the save.
  await expect(empty(page)).toBeVisible({ timeout: 15000 })

  // The switch was the last thing the server was asked for: the save had already landed, in the
  // workspace the sentence was typed in.
  expect(order).toEqual(['save', 'switch'])
  expect(readFileSync(app.articlePath(), 'utf8')).toContain('and a late thought')
  expect(existsSync(path.join(second, 'content', 'posts', 'hello-openwrite'))).toBe(false)
})

test('an entry can be renamed, and removed from the list without deleting anything', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const second = await createSecond(page, app)

  await runCommand(page, `rename workspace: ${path.basename(app.workspace)}`)
  await answer(page, `New name for ${path.basename(app.workspace)}`, 'The first one')

  await openPalette(page, 'switch to workspace')
  await expect(
    page.getByRole('option', { name: 'Switch to workspace: The first one' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')

  await runCommand(page, 'remove workspace from the list: The first one')
  await openPalette(page, 'switch to workspace')
  await expect(page.getByRole('option', { name: /Switch to workspace/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Removing it from the list deleted nothing.
  expect(existsSync(app.articlePath())).toBe(true)
  expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
})

test.describe('deleting a workspace from disk', () => {
  /** Leave `doomed` on disk, in the list, and not the workspace that is open. */
  async function ready(page: import('@playwright/test').Page, app: App): Promise<string> {
    await openArticle(page)
    const doomed = path.join(app.workspacesDir, 'doomed')
    await runCommand(page, 'new workspace')
    await answer(page, 'New workspace name', 'doomed')
    await expect(empty(page)).toBeVisible()
    await runCommand(page, 'switch to workspace')
    await expect(articleHeading(page)).toBeVisible()
    return doomed
  }
  const prompt = (page: import('@playwright/test').Page) =>
    page.getByRole('combobox', { name: 'Delete doomed from disk' })

  // Surrounding space is trimmed, as it is for every other palette input — a stray space is not
  // evidence of an accident, and the name that was typed still is. A different name is not.
  test('the wrong name deletes nothing and leaves the prompt open', async ({ page, app }) => {
    const doomed = await ready(page, app)
    await runCommand(page, 'delete workspace from disk: doomed')
    for (const wrong of ['Doomed', 'doome', 'yes']) {
      await prompt(page).fill(wrong)
      await page.keyboard.press('Enter')
      await expect(prompt(page)).toBeVisible()
      await expect(prompt(page)).toHaveValue(wrong)
    }
    expect(existsSync(doomed)).toBe(true)
  })

  test('Escape deletes nothing', async ({ page, app }) => {
    const doomed = await ready(page, app)
    await runCommand(page, 'delete workspace from disk: doomed')
    await prompt(page).fill('doomed')
    await page.keyboard.press('Escape')

    await expect(prompt(page)).toBeHidden()
    expect(existsSync(doomed)).toBe(true)
  })

  test('moving the focus away deletes nothing', async ({ page, app }) => {
    const doomed = await ready(page, app)
    await runCommand(page, 'delete workspace from disk: doomed')
    await prompt(page).fill('doomed')
    await prompt(page).blur()

    await expect(prompt(page)).toBeHidden()
    expect(existsSync(doomed)).toBe(true)
  })

  test('typing the name exactly deletes it, and only it', async ({ page, app }) => {
    const doomed = await ready(page, app)
    await runCommand(page, 'delete workspace from disk: doomed')
    await prompt(page).fill('doomed')
    await page.keyboard.press('Enter')

    await expect(prompt(page)).toBeHidden()
    await expect.poll(() => existsSync(doomed), { timeout: 5000 }).toBe(false)

    // The workspace that is open is untouched, and the entry is gone from the list.
    await expect(articleHeading(page)).toBeVisible()
    expect(existsSync(app.articlePath())).toBe(true)
    await openPalette(page, 'delete workspace from disk')
    await expect(page.getByRole('option', { name: /doomed/ })).toHaveCount(0)
  })
})
