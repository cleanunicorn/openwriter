import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { type App, expect, test } from './fixtures.ts'
import {
  blockEnd,
  blockWith,
  dropEventStreams,
  editor,
  expectFile,
  notice,
  openArticle,
} from './helpers.ts'

/** The article as another program would rewrite it: one heading changed, nothing else. */
const withHeading = (app: App, heading: string): string =>
  app.readArticle().replace('## Why blocks', heading)

test('an outside change reloads the document without losing the focused block’s edits', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' UNSAVED')

  // Another editor rewrites a different block (save-by-rename, like many editors do).
  writeFileSync(`${app.articlePath()}.tmp`, withHeading(app, '## Why blocks, from outside'))
  renameSync(`${app.articlePath()}.tmp`, app.articlePath())

  await expect(page.getByRole('heading', { name: 'Why blocks, from outside' })).toBeVisible()
  await expect(notice(page)).toContainText('changed on disk')
  // The focused editor kept the unsaved text…
  await expect(editor(page)).toContainText('reject the rest. UNSAVED')
  // …and both changes end up in the file.
  await page.keyboard.press('Escape')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('## Why blocks, from outside')
    expect(file).toContain('reject the rest. UNSAVED')
  })
})

/** How many times `needle` occurs in `text` — a duplicate is a count, never a substring. */
const occurrences = (text: string, needle: string) => text.split(needle).length - 1

test('a new block the autosave already wrote is not duplicated by a reload', async ({
  page,
  app,
}) => {
  await openArticle(page)
  // The reported gesture: Enter at the end of a block, the ordinary way to start a paragraph.
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveText('')

  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )
  await page.keyboard.type('A brand new paragraph.')
  await saved
  // The paragraph is on disk now, while its editor is still open and still holding it.
  expect(occurrences(app.readArticle(), 'A brand new paragraph.')).toBe(1)

  // Another writer changes a different block. The reload this triggers carries the file as it
  // now is — our paragraph included.
  writeFileSync(app.articlePath(), withHeading(app, '## Why blocks, from outside'))
  await expect(page.getByRole('heading', { name: 'Why blocks, from outside' })).toBeVisible()
  await expect(blockWith(page, 'A brand new paragraph.')).toHaveCount(1)
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('## Why blocks, from outside')
    expect(occurrences(file, 'A brand new paragraph.')).toBe(1)
  })

  // …and it survives the round trip: still one block after a reload from disk.
  await page.reload()
  await expect(blockWith(page, 'A brand new paragraph.')).toHaveCount(1)
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
  writeFileSync(app.articlePath(), withHeading(app, '## Why blocks, while disconnected'))

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
  writeFileSync(app.articlePath(), withHeading(app, '## Why blocks, from outside'))
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
    const file = app.readArticle()
    expect(file).toContain('## Why blocks, from outside')
    expect(file).toContain('reject the rest. MINE')
  }).toPass({ timeout: 8000 })
})
