import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import {
  ask,
  blockWith,
  editor,
  expectWaiting,
  ghosts,
  jobState,
  notice,
  openArticle,
  release,
  selectWord,
  tray,
} from './helpers.ts'

async function runToEnd(page: Page, app: App, instruction: string, repair = false) {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, instruction)
  const [id] = await expectWaiting(app, 1)
  await release(app, id)
  if (repair && id !== undefined) {
    // The repair attempt is the same job reaching its checkpoint a second time.
    await expect(async () => expect(await jobState(app, id)).toBe('repairing')).toPass()
    await expectWaiting(app, 1)
    await release(app, id)
  }
  await tray(page).getByRole('button').first().click()
}

test('an agent error becomes a failed job in the tray, and editing goes on', async ({
  page,
  app,
}) => {
  await runToEnd(page, app, 'fake:fail')
  await expect(tray(page)).toContainText('failed · agent error')
  await expect(tray(page)).toContainText('exited with code 1')
  await expect(ghosts(page)).toHaveCount(0)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.type('x')
  await expect(editor(page)).toContainText('x')
})

test('an auth error says how to fix it', async ({ page, app }) => {
  await runToEnd(page, app, 'fake:auth')
  await expect(tray(page)).toContainText('failed · not signed in')
  await expect(tray(page)).toContainText('sign in')
})

test('a malformed result is repaired once', async ({ page, app }) => {
  await runToEnd(page, app, 'fake:invalid-once', true)
  await expect(tray(page)).toContainText('ready for review')
  await expect(ghosts(page)).toHaveCount(1)
})

test('after one failed repair the raw output is shown', async ({ page, app }) => {
  await runToEnd(page, app, 'fake:invalid-twice', true)
  await expect(tray(page)).toContainText('failed · invalid result')
  await tray(page).getByText('Show the agent’s output').click()
  await expect(tray(page)).toContainText('not quite json')
})

test('a running job can be cancelled from the tray', async ({ page, app }) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  await expectWaiting(app, 1)
  await tray(page).getByRole('button', { name: '1 running' }).click()
  await tray(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(tray(page)).toContainText('cancelled')
  await expect(blockWith(page, 'Why blocks')).not.toHaveClass(/is-pending/)
  await tray(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(tray(page)).toHaveCount(0)
})

test('a decision the server cannot record says so and keeps the proposal on screen', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  await expectWaiting(app, 1)
  await release(app)
  await expect(ghosts(page)).toHaveCount(1)

  await page.route('**/api/jobs/*/decisions', (route) => route.abort('failed'))
  await ghosts(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(notice(page)).toContainText('Could not record the decision')
  await expect(ghosts(page)).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'Why blocks', exact: true })).toHaveCount(0)

  // Once the server answers again the same proposal can still be accepted.
  await page.unroute('**/api/jobs/*/decisions')
  await ghosts(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'WHY BLOCKS' })).toBeVisible()
})
