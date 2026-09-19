import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import {
  acceptButton,
  ask,
  blockStart,
  blockWith,
  expectFile,
  expectWaiting,
  ghosts,
  jobFile,
  mod,
  notice,
  openArticle,
  rejectButton,
  release,
  selectWord,
  tray,
  waitingJobs,
} from './helpers.ts'

test('a second job on a busy block queues behind it and runs against the settled outcome', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const heading = blockWith(page, 'Why blocks')
  await selectWord(page, heading, 'Why blocks')
  await ask(page, 'fake:upper first')
  const [firstId] = await expectWaiting(app, 1)

  await selectWord(page, heading, 'Why blocks')
  await ask(page, 'fake:insert second')
  await tray(page).getByRole('button', { name: '2 running' }).click()
  await expect(tray(page)).toContainText('queued behind another job')
  expect(await waitingJobs(app)).toEqual([firstId])

  // The first job finishes, but it is not settled until it is reviewed: the second still waits.
  await release(app, firstId)
  await expect(ghosts(page)).toHaveCount(1)
  await expect(tray(page)).toContainText('queued behind another job')
  expect(await waitingJobs(app)).toEqual([])

  // Accepting settles it; only now does the second job start — against the accepted text.
  await acceptButton(ghosts(page)).click()
  const [secondId] = await expectWaiting(app, 1)
  expect(secondId).not.toBe(firstId)
  const snapshot = readFileSync(jobFile(app, secondId, 'article.md'), 'utf8')
  expect(snapshot).toContain('## WHY BLOCKS')
  await release(app, secondId)
  await expect(ghosts(page)).toContainText('Inserted by the fake agent.')
})

test('a rejected outcome releases the queue as well', async ({ page, app }) => {
  await openArticle(page)
  const heading = blockWith(page, 'Why blocks')
  await selectWord(page, heading, 'Why blocks')
  await ask(page, 'fake:upper first')
  await selectWord(page, heading, 'Why blocks')
  await ask(page, 'fake:upper second')
  const [firstId] = await expectWaiting(app, 1)
  await release(app, firstId)
  await rejectButton(ghosts(page)).click()
  const [secondId] = await expectWaiting(app, 1)
  const snapshot = readFileSync(jobFile(app, secondId, 'article.md'), 'utf8')
  expect(snapshot).toContain('## Why blocks')
})

test('editing a block while its job runs flags the result and diffs against the current text', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  await expectWaiting(app, 1)

  // The job never locks editing, not even of its own target.
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' today')
  await page.keyboard.press('Escape')
  await release(app)

  const ghost = ghosts(page)
  await expect(ghost).toContainText('changed since request')
  // Diffed against "## Why blocks today", not the snapshot: "today" is what gets removed.
  await expect(ghost.locator('del').last()).toContainText('today')
  await acceptButton(ghost).click()
  await expectFile(app.articlePath(), (file) => expect(file).toContain('## WHY BLOCKS\n'))
})

test('an article job is exclusive: it waits for running jobs, and new block jobs queue behind it', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper block job')
  const [blockJob] = await expectWaiting(app, 1)

  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('whole article')
  await page.keyboard.press('Enter')
  await page
    .getByRole('combobox', { name: 'Instruction for the whole article' })
    .fill('fake:insert article job')
  await page.keyboard.press('Enter')

  await selectWord(page, blockWith(page, 'Results arrive as ghost diffs'), 'Results')
  await ask(page, 'fake:upper late block job')
  // Only the first job runs; the article job and the later block job are held, in order.
  expect(await waitingJobs(app)).toEqual([blockJob])
  await tray(page).getByRole('button', { name: '3 running' }).click()
  await expect(tray(page).getByText('queued behind another job')).toHaveCount(2)

  await release(app, blockJob)
  await acceptButton(ghosts(page)).click()
  const [articleJob] = await expectWaiting(app, 1)
  const instruction = readFileSync(jobFile(app, articleJob, 'instruction.md'), 'utf8')
  expect(instruction).toContain('article job')
  expect(instruction).toContain('Scope `article`')
  await expect(tray(page).getByText('queued behind another job')).toHaveCount(1)

  await release(app, articleJob)
  await acceptButton(ghosts(page)).click()
  const [lateJob] = await expectWaiting(app, 1)
  expect(readFileSync(jobFile(app, lateJob, 'instruction.md'), 'utf8')).toContain('late block job')
})

test('an ordinary merge while a whole-article job runs does not cancel it', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('whole article')
  await page.keyboard.press('Enter')
  await page
    .getByRole('combobox', { name: 'Instruction for the whole article' })
    .fill('fake:insert long draft')
  await page.keyboard.press('Enter')
  await expectWaiting(app, 1)

  // Backspace at the start of a paragraph merges it into the one above: one block id disappears.
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockStart)
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  await expect(page.getByText('Results arrive as ghost diffs')).toBeVisible()

  await release(app)
  await expect(ghosts(page)).toHaveCount(1)
  await tray(page).getByRole('button').first().click()
  await expect(tray(page)).toContainText('ready for review')
  await expect(tray(page)).not.toContainText('stale')
})

test('deleting a target block marks the job stale and keeps its output', async ({ page, app }) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Results arrive as ghost diffs'), 'Results')
  await ask(page, 'fake:upper')
  await expectWaiting(app, 1)

  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')

  await tray(page).getByRole('button').first().click()
  await expect(tray(page)).toContainText('stale')
  await expect(tray(page)).toContainText('A target block was deleted')
  await expect(ghosts(page)).toHaveCount(0)
})

test('a page reload counts as a restart: the review becomes stale, its output stays visible', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  await expectWaiting(app, 1)
  await release(app)
  await expect(ghosts(page)).toHaveCount(1)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })).toBeVisible()
  await tray(page).getByRole('button').first().click()
  await expect(tray(page)).toContainText('stale')
  await tray(page).getByText('Show the agent’s output').click()
  await expect(tray(page)).toContainText('WHY BLOCKS')
  await expect(ghosts(page)).toHaveCount(0)
})

test('a queued instruction whose block is deleted is dropped, with a notice, and never starts', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const paragraph = blockWith(page, 'Results arrive as ghost diffs')
  await selectWord(page, paragraph, 'Results')
  await ask(page, 'fake:upper first')
  const [firstId] = await expectWaiting(app, 1)
  await selectWord(page, paragraph, 'Results')
  await ask(page, 'fake:upper second, held behind the first')
  await tray(page).getByRole('button', { name: '2 running' }).click()
  await expect(tray(page)).toContainText('queued behind another job')

  // The writer deletes the block both instructions were about.
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')

  await expect(notice(page)).toContainText('A queued instruction was dropped')
  await expect(tray(page)).not.toContainText('queued behind another job')
  // The running job goes stale; the dropped one never reaches the server.
  await expect(tray(page)).toContainText('stale')
  await release(app, firstId)
  expect(await waitingJobs(app)).toEqual([])
  const jobs = (await (await fetch(`${app.url}/api/jobs`)).json()) as { jobs: unknown[] }
  expect(jobs.jobs).toHaveLength(1)
})
