import { accessSync, chmodSync, constants, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import {
  acceptButton,
  articleHeading,
  ask,
  blockEnd,
  blockWith,
  editor,
  expectFile,
  expectOneWaiting,
  ghosts,
  jobState,
  notice,
  openArticle,
  release,
  selectWord,
  tray,
  waitingJobs,
} from './helpers.ts'

// A reload keeps the tab's block IDs and the requests it holds (src/client/state/session.ts):
// what was running, queued or waiting for review before it is still this tab's to review after.

test('a job that was running when the page reloaded is still running, and its result lands on the right block', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  const id = await expectOneWaiting(app)

  await page.reload()
  await expect(articleHeading(page)).toBeVisible()
  await tray(page).getByRole('button', { name: '1 running' }).click()
  await expect(tray(page)).toContainText('running')
  await expect(blockWith(page, 'Why blocks')).toHaveClass(/is-pending/)

  await release(app, id)
  const ghost = ghosts(page)
  await expect(ghost).toHaveCount(1)
  await expect(ghost.locator('ins').first()).toHaveText('WHY')
  await acceptButton(ghost).click()
  await expect(page.getByRole('heading', { name: 'WHY BLOCKS' })).toBeVisible()
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('## WHY BLOCKS\n')
    expect(file).not.toContain('## Why blocks')
    // The IDs that carried the job across the reload never reach the article.
    expect(file).not.toContain('zen:block')
  })
  expect(await jobState(app, id)).toBe('settled')
})

test('a proposal waiting for review survives a reload and can still be accepted', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Results arrive as ghost diffs'), 'Results')
  await ask(page, 'fake:upper')
  await release(app, await expectOneWaiting(app))
  await expect(ghosts(page)).toHaveCount(1)

  await page.reload()
  await expect(articleHeading(page)).toBeVisible()
  await expect(ghosts(page)).toHaveCount(1)
  await acceptButton(ghosts(page)).click()
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('RESULTS ARRIVE AS GHOST DIFFS')
    expect(file).toContain('## Why blocks\n')
  })
})

test('a request queued behind another job is still queued after a reload, and starts when it may', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const paragraph = blockWith(page, 'Results arrive as ghost diffs')
  await selectWord(page, paragraph, 'Results')
  await ask(page, 'fake:upper first')
  const first = await expectOneWaiting(app)
  await selectWord(page, paragraph, 'Results')
  await ask(page, 'fake:upper second, held behind the first')
  await page.reload()
  await expect(articleHeading(page)).toBeVisible()
  await tray(page).getByRole('button', { name: '2 running' }).click()
  await expect(tray(page)).toContainText('queued behind another job')
  expect(await waitingJobs(app)).toEqual([first])

  // The first one finishes and is accepted; only then does the held one start, against the result.
  await release(app, first)
  await acceptButton(ghosts(page)).click()
  await expect(tray(page)).not.toContainText('queued behind another job')
  const second = await expectOneWaiting(app)
  expect(second).not.toBe(first)
  await release(app, second)
  await expect(ghosts(page)).toHaveCount(1)
})

test('a block that changed on disk while the page was away does not keep its ID: the job goes stale', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  await release(app, await expectOneWaiting(app))
  await expect(ghosts(page)).toHaveCount(1)

  // Away from the app (the tab keeps its session storage), someone rewrites that heading.
  await page.goto('about:blank')
  writeFileSync(app.articlePath(), app.readArticle().replace('## Why blocks', '## Why not lines'))
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Why not lines' })).toBeVisible()
  await tray(page).getByRole('button').first().click()
  await expect(tray(page)).toContainText('stale')
  await expect(tray(page)).toContainText('A target block was deleted')
  await expect(ghosts(page)).toHaveCount(0)
  expect(app.readArticle()).toContain('## Why not lines')
})

test('a job whose tab was closed goes stale in the next tab, with its output kept', async ({
  page,
  app,
  context,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  const id = await expectOneWaiting(app)
  await release(app, id)
  await expect(ghosts(page)).toHaveCount(1)
  await page.close({ runBeforeUnload: false })

  // A new tab has block IDs of its own: the proposal cannot be put on them.
  const next = await context.newPage()
  await openArticle(next)
  await tray(next).getByRole('button').first().click()
  await expect(tray(next)).toContainText('stale')
  await next.getByText('Show the agent’s output').click()
  await expect(tray(next)).toContainText('WHY BLOCKS')
  await expect(ghosts(next)).toHaveCount(0)
  expect(await jobState(app, id)).toBe('stale')
})

test('another open tab shows the job but leaves it to the tab that asked', async ({
  page,
  app,
  context,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  const id = await expectOneWaiting(app)

  // Opened while the job runs: it must not mark it stale, and must not decorate its own blocks.
  const other = await context.newPage()
  await openArticle(other)
  await tray(other).getByRole('button', { name: '1 running' }).click()
  await expect(tray(other)).toContainText('started in another tab')
  await expect(blockWith(other, 'Why blocks')).not.toHaveClass(/is-pending/)

  await release(app, id)
  await expect(ghosts(page)).toHaveCount(1)
  await expect(tray(other)).toContainText('ready for review')
  await expect(ghosts(other)).toHaveCount(0)
  expect(await jobState(app, id)).toBe('ready')

  // The asking tab can still reload and accept it.
  await page.reload()
  await acceptButton(ghosts(page)).click()
  await expectFile(app.articlePath(), (file) => expect(file).toContain('## WHY BLOCKS\n'))
})

// A block finished with Esc but not saved yet (#38): the reload merges three ways, as a live
// reload does (#30), instead of taking the disk's text.

const SECOND = 'stays plain markdown.'

// A test that fails before the next page reads the document leaves the directory read-only;
// the workspace copy could not be removed then.
test.afterEach(({ app }) => chmodSync(path.dirname(app.articlePath()), 0o755))

/**
 * Type ` BBB` at the end of the second paragraph, and press Esc when `finish` says so, while no
 * save of this page can reach the disk: the article's directory is read-only (a save writes a
 * temp file and renames it) until the next page reads the document. That is a reload inside the
 * 750 ms autosave debounce whose last save — the one `visibilitychange` sends as the page goes —
 * never landed, without depending on timing. Holding or aborting the request with `route` does
 * not stop that last save: a request the page sends while it goes can escape the interception,
 * and landed in about half the runs tried.
 */
async function editWithoutSaving(page: Page, app: App, finish: boolean): Promise<void> {
  const directory = path.dirname(app.articlePath())
  chmodSync(directory, 0o555)
  // As root the mode would not stop the save, and the test would time out saying nothing useful.
  expect(() => accessSync(directory, constants.W_OK), 'the directory is read-only').toThrow()
  // Set up after this page read the document, so the next read of it is the next page's.
  await page.route('**/api/docs/**', async (route) => {
    const request = route.request()
    if (request.method() === 'GET' && request.url().endsWith('/hello-openwrite'))
      chmodSync(directory, 0o755)
    await route.continue()
  })
  await page.getByText('Every paragraph, list').click()
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' BBB')
  if (finish) {
    await page.keyboard.press('Escape')
    await expect(editor(page)).toHaveCount(0)
  }
  await expect(blockWith(page, `${SECOND} BBB`)).toHaveCount(1)
  // The unload guard asks before leaving a tab with unsaved text; the writer leaves.
  page.on('dialog', (dialog) => void dialog.accept())
}

const savedOnce = (page: Page) =>
  page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )

for (const [how, finish] of [
  ['finished with Esc', true],
  ['still open in its editor', false],
] as const) {
  test(`a block ${how} but not saved before a reload is still there after it, and is saved (#38)`, async ({
    page,
    app,
  }) => {
    await openArticle(page)
    await editWithoutSaving(page, app, finish)
    expect(app.readArticle()).not.toContain('BBB')

    const saved = savedOnce(page)
    await page.reload()
    await expect(articleHeading(page)).toBeVisible()
    await expect(blockWith(page, `${SECOND} BBB`)).toHaveCount(1)
    await saved
    await expectFile(app.articlePath(), (file) => expect(file).toContain(`${SECOND} BBB`))
    // Nothing on disk changed meanwhile, so there is nothing to tell the writer.
    await expect(notice(page)).toHaveCount(0)
  })
}

test('a finished unsaved block the disk also changed while the page was away is a conflict (#38)', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await editWithoutSaving(page, app, true)

  // Away from the app (the tab keeps its session storage), someone edits the same paragraph.
  await page.goto('about:blank')
  writeFileSync(app.articlePath(), app.readArticle().replace(SECOND, `${SECOND} DISK`))
  await page.goto('/')
  await expect(articleHeading(page)).toBeVisible()

  // The disk's version is in the document; the writer's is kept aside until they choose.
  const conflict = page.getByRole('group', { name: 'Conflict' })
  await expect(conflict).toContainText('BBB')
  await expect(blockWith(page, `${SECOND} DISK`)).toHaveCount(1)
  await expect(blockWith(page, 'BBB')).toHaveCount(0)
  await expect(notice(page)).toContainText('Choose which version to keep.')
  expect(app.readArticle()).not.toContain('BBB')

  const saved = savedOnce(page)
  await conflict.getByRole('button', { name: 'Keep mine' }).click()
  await saved
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain(`${SECOND} BBB`)
    expect(file).not.toContain('DISK')
  })
})
