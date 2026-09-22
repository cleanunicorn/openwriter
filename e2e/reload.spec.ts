import { writeFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import {
  acceptButton,
  articleHeading,
  ask,
  blockWith,
  expectFile,
  expectOneWaiting,
  ghosts,
  jobState,
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
