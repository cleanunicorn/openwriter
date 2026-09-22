import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  answer,
  articleHeading,
  ask,
  blockWith,
  dropEventStreams,
  expectOneWaiting,
  ghosts,
  jobFile,
  openArticle,
  release,
  runCommand,
  selectWord,
  tray,
  waitingJobs,
} from './helpers.ts'

// The job tray across a workspace switch. Jobs belong to a workspace: the server marks the ones
// it leaves unsettled as stale (with their output kept) and stops their agents; every tab drops
// them from its tray and loads the new workspace's jobs instead. A job of the old workspace must
// never come back into the new one's tray — not from a late event, not from a reconnect — and
// switching back finds it again, where it was left.

/** The one-line count: in the corner while the agent panel is closed, atop its transcript when open. */
const count = (page: Page) => tray(page).first().getByRole('button').first()

/** Open the agent panel unless it is open already: the panels are a workspace setting. */
async function showTurns(page: Page): Promise<void> {
  if ((await count(page).getAttribute('aria-expanded')) === 'false') await count(page).click()
  await expect(count(page)).toHaveAttribute('aria-expanded', 'true')
}
/** The turns of the agent panel's transcript: one list item per job. */
const turns = (page: Page) => page.getByRole('region', { name: 'Agent jobs' }).getByRole('listitem')

test("the tray drops the old workspace's jobs on a switch, in every tab, and finds them again on the way back", async ({
  page,
  app,
  context,
}) => {
  // A second tab, open before any job exists: it follows the switch through its event stream.
  const other = await context.newPage()
  await openArticle(other)
  await openArticle(page)

  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper a job of the first workspace')
  const first = await expectOneWaiting(app)
  await expect(count(page)).toHaveText('1 running')
  await expect(count(other)).toHaveText('1 running')

  await runCommand(page, 'new workspace')
  await answer(page, 'New workspace name', 'second')
  for (const tab of [page, other]) {
    await expect(tab.getByText('No article yet')).toBeVisible()
    await expect(tray(tab)).toHaveCount(0)
  }
  // The server let the job go: stale on the first workspace's disk, its agent stopped, and
  // unknown to the server now. Nothing is left for a late event to report.
  const onDisk = JSON.parse(readFileSync(jobFile(app, first, 'job.json'), 'utf8')) as {
    job: { state: string }
  }
  expect(onDisk.job.state).toBe('stale')
  expect(await waitingJobs(app)).toEqual([])
  expect((await fetch(`${app.url}/api/jobs/${first}`)).status).toBe(404)

  // A reconnect re-reads the jobs from the server: still only the new workspace's (none).
  await dropEventStreams(app)
  await expect(tray(page)).toHaveCount(0)

  // The second workspace's own job shows, and it is the only one.
  await runCommand(page, 'new article')
  await answer(page, 'Article title', 'Hello, openwrite')
  await expect(articleHeading(page)).toBeVisible()
  await selectWord(page, blockWith(page, 'Hello, openwrite'), 'Hello')
  await ask(page, 'fake:upper a job of the second workspace')
  const second = await expectOneWaiting(app)
  expect(second).not.toBe(first)
  await release(app, second)
  await expect(ghosts(page)).toHaveCount(1)
  await expect(count(page)).toHaveText('1 to review')
  await expect(count(other)).toHaveText('1 to review')
  await showTurns(page)
  await expect(turns(page)).toHaveCount(1)
  await expect(turns(page)).toContainText('a job of the second workspace')

  // Back to the first: its job is there again, stale with the switch as the reason, and the
  // second workspace's job and ghost are gone.
  await runCommand(page, `switch to workspace: ${path.basename(app.workspace)}`)
  await expect(blockWith(page, 'Why blocks')).toBeVisible()
  await expect(ghosts(page)).toHaveCount(0)
  await expect(count(page)).toHaveText('1 need a look')
  await showTurns(page)
  await expect(turns(page)).toHaveCount(1)
  await expect(turns(page)).toContainText('a job of the first workspace')
  await expect(turns(page)).toContainText('stale')
  await expect(turns(page)).toContainText('The editor moved to another workspace')
  await expect(count(other)).toHaveText('1 need a look')
})
