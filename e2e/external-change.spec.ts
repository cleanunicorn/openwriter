import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import {
  blockEnd,
  blockWith,
  dropEventStreams,
  editor,
  expectFile,
  mod,
  notice,
  occurrences,
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

/**
 * The reported gesture, carried all the way to disk: Enter at the end of the last paragraph,
 * type into the slot it opens, and wait for the autosave that writes the still-open slot's
 * text to the file. What happens next is what each test is about.
 */
async function newBlockSavedToDisk(page: Page, text: string): Promise<void> {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveText('')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )
  await page.keyboard.type(text)
  await saved
}

test('a new block the autosave already wrote is not duplicated by a reload', async ({
  page,
  app,
}) => {
  await newBlockSavedToDisk(page, 'A brand new paragraph.')
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

test('a reload keeps what was typed after the save it carries', async ({ page, app }) => {
  await newBlockSavedToDisk(page, 'A brand new paragraph.')

  // Hold every later save, so the editor provably holds more than the disk does: no timing.
  await page.route('**/api/docs/**', (route) =>
    route.request().method() === 'PUT' ? route.abort() : route.continue(),
  )
  await page.keyboard.type(' AND MORE')

  // The outside change carries the file as it was saved — without ' AND MORE'. The reload
  // folds the slot into a real block, which moves the editor; it must not be rebuilt from the
  // disk's copy of the paragraph.
  writeFileSync(app.articlePath(), withHeading(app, '## Why blocks, from outside'))
  await expect(page.getByRole('heading', { name: 'Why blocks, from outside' })).toBeVisible()
  await expect(editor(page)).toHaveText('A brand new paragraph. AND MORE')
})

test('an unclosed fence does not swallow the rest of the article across a reload', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Every paragraph, list').click()
  // Replace the whole paragraph with an unclosed fence: from here it swallows every block
  // after it, so what autosave writes is one big block while the editor holds only two lines.
  await page.keyboard.press(`${mod}+a`)
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )
  await page.keyboard.type('```js\nnever closed')
  await saved

  // Another writer touches a paragraph above it, and the reload brings our own save back.
  writeFileSync(
    app.articlePath(),
    app.readArticle().replace('This is a sample article', 'This is a CHANGED article'),
  )
  await expect(notice(page)).toContainText('changed on disk')

  // Leaving the editor commits what it holds. That must not be the short version: everything
  // the fence took in has to survive the commit on screen, and then the save that follows it.
  await page.keyboard.press('Escape')
  await expect(page.getByText('A paired Hugo shortcode stays one block')).toBeVisible()
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('This is a CHANGED article')
    expect(file).toContain('A paired Hugo shortcode stays one block')
    expect(file).toContain('## What is next')
  })
})

test('a heading typed under a paragraph is not duplicated by a reload and a blur', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.press('Enter')
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )
  // One editor, two blocks' worth of markdown: the heading is a block of its own once saved.
  await page.keyboard.type('## A heading typed inline')
  await saved
  expect(occurrences(app.readArticle(), '## A heading typed inline')).toBe(1)

  writeFileSync(app.articlePath(), withHeading(app, '## Why blocks, from outside'))
  await expect(page.getByRole('heading', { name: 'Why blocks, from outside' })).toBeVisible()

  // The reload folds the heading into the document, so the editor must stop holding it too —
  // otherwise closing the editor writes it a second time.
  await page.keyboard.press('Escape')
  await expectFile(app.articlePath(), (file) => {
    expect(occurrences(file, '## A heading typed inline')).toBe(1)
  })
  await expect(blockWith(page, 'A heading typed inline')).toHaveCount(1)
})

test('a block deleted from outside while it was being edited is saved again', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )
  await page.keyboard.type(' MINE')
  await saved

  // Another writer removes that whole paragraph. The reducer keeps the open editor's text, so
  // the live text goes back to exactly what was last saved — and autosave must still write it,
  // because the disk has moved on and no longer has it.
  // The blank line after it goes too, so restoring the paragraph reproduces the saved file
  // byte for byte — which is exactly when a text-keyed autosave check calls it a repeat.
  writeFileSync(
    app.articlePath(),
    app.readArticle().replace(/^Results arrive as ghost diffs.*\n\n/m, ''),
  )
  await expect(notice(page)).toContainText('was kept')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('reject the rest. MINE')
  })
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

// `reconcile` gives the first block of a changed run the old ID of that run. In both tests below
// another program edits a block *and* puts a paragraph in front of it, so the edited block's old
// ID ends up on the inserted paragraph — and whatever trusts that ID lands on the wrong side.

test('a block deleted from outside comes back under its heading, not above it', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Every paragraph, list').click()
  await page.keyboard.press(blockEnd)
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === 200,
  )
  await page.keyboard.type(' MINE')
  await saved

  // The paragraph being edited goes; the heading above it is reworded and gets a paragraph in
  // front of it, which inherits the heading's ID.
  writeFileSync(
    app.articlePath(),
    app
      .readArticle()
      .replace(/^Every paragraph, list.*\n\n/m, '')
      .replace('## Why blocks\n', 'Inserted from outside.\n\n## Why blocks, reworded\n'),
  )
  await expect(notice(page)).toContainText('was kept')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain(
      '## Why blocks, reworded\n\nEvery paragraph, list, and code fence is a block.',
    )
    expect(file).toContain('stays plain markdown. MINE\n\n- Blocks are slices')
  })
})

test('an open new-block slot stays under the block it was opened after', async ({ page, app }) => {
  await openArticle(page)
  await page.getByText('Every paragraph, list').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveText('')

  // The block the slot was opened after is edited, and a paragraph put in front of it inherits
  // its ID.
  writeFileSync(
    app.articlePath(),
    app
      .readArticle()
      .replace('Every paragraph, list', 'Inserted from outside.\n\nEvery paragraph, list')
      .replace('stays plain markdown.', 'stays plain markdown!'),
  )
  await expect(page.getByText('Inserted from outside.')).toBeVisible()
  await page.keyboard.type('Typed into the slot.')
  await page.keyboard.press('Escape')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('stays plain markdown!\n\nTyped into the slot.\n\n- Blocks are slices')
  })
})
