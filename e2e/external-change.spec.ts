import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import { blockEnd, dropEventStreams, editor, notice, openArticle } from './helpers.ts'

test('an outside change reloads the document without losing the focused block’s edits', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' UNSAVED')

  // Another editor rewrites a different block (save-by-rename, like many editors do).
  const changed = readFileSync(app.articlePath(), 'utf8').replace(
    '## Why blocks',
    '## Why blocks, from outside',
  )
  writeFileSync(`${app.articlePath()}.tmp`, changed)
  const { renameSync } = await import('node:fs')
  renameSync(`${app.articlePath()}.tmp`, app.articlePath())

  await expect(page.getByRole('heading', { name: 'Why blocks, from outside' })).toBeVisible()
  await expect(notice(page)).toContainText('changed on disk')
  // The focused editor kept the unsaved text…
  await expect(editor(page)).toContainText('reject the rest. UNSAVED')
  // …and both changes end up in the file.
  await page.keyboard.press('Escape')
  await expect(() => {
    const file = readFileSync(app.articlePath(), 'utf8')
    expect(file).toContain('## Why blocks, from outside')
    expect(file).toContain('reject the rest. UNSAVED')
  }).toPass({ timeout: 5000 })
})

test('a file deleted from outside is not recreated from memory', async ({ page, app }) => {
  await openArticle(page)
  rmSync(app.articlePath())
  await expect(notice(page)).toContainText('deleted on disk')

  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.type('x')
  await page.keyboard.press('Escape')
  await expect(notice(page)).toContainText('Autosave is paused')
  // Longer than the autosave debounce, asserted by polling a condition that must stay true.
  await expect(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(existsSync(app.articlePath())).toBe(false)
  }).toPass()
})

test('a change made while the event stream was down is picked up on reconnect', async ({
  page,
  app,
}) => {
  await openArticle(page)
  // Nothing is typed: a dirty document would save, get a 409, and reconcile through that path.
  // The server ends the stream and keeps no replay, so the event for this change is lost for
  // good; only the client's re-check on reconnect can bring the change in.
  await dropEventStreams(app)
  const changed = readFileSync(app.articlePath(), 'utf8').replace(
    '## Why blocks',
    '## Why blocks, while disconnected',
  )
  writeFileSync(app.articlePath(), changed)

  // EventSource reconnects by itself after a few seconds.
  await expect(page.getByRole('heading', { name: 'Why blocks, while disconnected' })).toBeVisible({
    timeout: 15_000,
  })
})

test('a save that loses the race with an outside change gets a 409 and keeps both edits', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)

  // No event will announce the outside change, so the autosave is the first to find out.
  await dropEventStreams(app)
  const changed = readFileSync(app.articlePath(), 'utf8').replace(
    '## Why blocks',
    '## Why blocks, from outside',
  )
  writeFileSync(app.articlePath(), changed)
  const conflict = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 409,
  )
  await page.keyboard.type(' MINE')
  await conflict

  // The 409 body carried the disk version: it is reconciled, the focused block keeps its text…
  await expect(page.getByRole('heading', { name: 'Why blocks, from outside' })).toBeVisible()
  await expect(editor(page)).toContainText('reject the rest. MINE')
  // …and the follow-up save writes both.
  await expect(() => {
    const file = readFileSync(app.articlePath(), 'utf8')
    expect(file).toContain('## Why blocks, from outside')
    expect(file).toContain('reject the rest. MINE')
  }).toPass({ timeout: 8000 })
})
