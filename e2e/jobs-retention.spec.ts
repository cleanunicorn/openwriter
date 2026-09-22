import { existsSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import {
  ask,
  blockWith,
  expectOneWaiting,
  ghosts,
  jobFile,
  jobState,
  notice,
  openArticle,
  release,
  runCommand,
  selectWord,
  tray,
} from './helpers.ts'

test('Clear finished jobs deletes a failed job and keeps one awaiting review, in every tab', async ({
  page,
  app,
  context,
}) => {
  // A second tab on the same server hears about the clear through its event stream. It shows the
  // other tab's jobs, and leaves them to that tab.
  const other = await context.newPage()
  await openArticle(other)
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:fail')
  const failed = await expectOneWaiting(app)
  await release(app, failed)
  await expect.poll(() => jobState(app, failed)).toBe('failed')

  await selectWord(page, blockWith(page, 'Results arrive'), 'Results')
  await ask(page, 'fake:upper')
  const ready = await expectOneWaiting(app)
  await release(app, ready)
  await expect(ghosts(page)).toHaveCount(1)

  await expect(tray(other).first()).toContainText('1 to review · 1 need a look')

  await tray(page).getByRole('button').first().click()
  await expect(tray(page)).toContainText('failed · agent error')
  await runCommand(page, 'Clear finished jobs')

  await expect(notice(page)).toContainText(
    'Cleared 1 finished job. Kept 1 job that is still queued, running or awaiting review.',
  )
  await expect(tray(page)).not.toContainText('failed')
  await expect(tray(page)).toContainText('ready for review')
  await expect(tray(other).first()).toContainText('1 to review')
  await expect(tray(other).first()).not.toContainText('need a look')
  expect(existsSync(jobFile(app, failed))).toBe(false)
  expect(existsSync(jobFile(app, ready, 'job.json'))).toBe(true)
  // The proposal that was kept is still reviewable where it was.
  await expect(ghosts(page)).toHaveCount(1)
})

test('Clear finished jobs says so when there is nothing to clear', async ({ page, app }) => {
  expect(existsSync(jobFile(app, ''))).toBe(false)
  await openArticle(page)
  await runCommand(page, 'Clear finished jobs')
  await expect(notice(page)).toContainText('No finished jobs to clear.')
})
