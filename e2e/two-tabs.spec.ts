import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import { blockEnd, blockWith, editor, expectFile, notice, openArticle } from './helpers.ts'

/**
 * Two tabs on the same article (README, "Two tabs on the same article"). These tests pin down
 * what actually happens, so the documentation stays true. Every save is announced to the other
 * tabs (#29), and each tab takes it in through the three-way merge a reload runs (#30): nothing
 * either tab wrote is dropped without the writer being shown it.
 */

const FIRST = 'This is a sample article.'
const SECOND = 'Every paragraph, list'

const put = (page: Page, status: number) =>
  page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.status() === status,
  )

async function typeAtEnd(page: Page, anchor: string, text: string): Promise<void> {
  await page.getByText(anchor).click()
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(text)
}

/** Hold every save `page` sends until the returned release is called: no timing involved. */
async function holdSaves(page: Page): Promise<() => void> {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/docs/**', async (route) => {
    if (route.request().method() === 'PUT') await held
    await route.continue()
  })
  return release
}

/** How many saves a page has sent so far. */
function countSaves(page: Page): () => number {
  let count = 0
  page.on('request', (request) => {
    if (request.method() === 'PUT') count += 1
  })
  return () => count
}

async function bothOpen(a: Page, b: Page): Promise<void> {
  await openArticle(a)
  await openArticle(b)
}

/** Tab A saves ` AAA` at the end of the first paragraph. */
async function aSavesFirstParagraph(a: Page, app: App): Promise<void> {
  const saved = put(a, 200)
  await typeAtEnd(a, FIRST, ' AAA')
  await saved
  await a.keyboard.press('Escape')
  await expectFile(app.articlePath(), (file) => expect(file).toMatch(/render it again\. AAA/))
}

test('a tab hears of another tab’s save at once, and says so (#29)', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await bothOpen(a, b)
  await aSavesFirstParagraph(a, app)

  // B takes A's paragraph in without saving anything itself; A is not told about its own save.
  await expect(blockWith(b, 'render it again. AAA')).toHaveCount(1)
  await expect(notice(b)).toContainText('Reloaded: another tab saved this file.')
  await expect(notice(a)).toHaveCount(0)

  // B's save is based on the file as it now is: accepted, not refused. A hears of it in turn.
  const saved = put(b, 200)
  await typeAtEnd(b, SECOND, ' BBB')
  await saved
  await expect(blockWith(a, 'stays plain markdown. BBB')).toHaveCount(1)
  await expect(notice(a)).toContainText('Reloaded: another tab saved this file.')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toMatch(/render it again\. AAA/)
    expect(file).toContain('stays plain markdown. BBB')
  })
})

test('the same block edited in two tabs, one after the other: each edits the latest text (#29)', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await bothOpen(a, b)
  await aSavesFirstParagraph(a, app)
  await expect(blockWith(b, 'render it again. AAA')).toHaveCount(1)

  // B edits the paragraph A saved, starting from A's text: its save keeps both words.
  const saved = put(b, 200)
  await typeAtEnd(b, FIRST, ' BBB')
  await saved
  await expectFile(app.articlePath(), (file) => expect(file).toMatch(/render it again\. AAA BBB/))
  await expect(blockWith(a, 'render it again. AAA BBB')).toHaveCount(1)
})

test('the same block typed in two tabs at once: a conflict, and no save ping-pong (#29)', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await bothOpen(a, b)
  const savesOfA = countSaves(a)
  const savesOfB = countSaves(b)

  // B types in the first paragraph; its save is held, so B's text is not on disk yet.
  const release = await holdSaves(b)
  const sent = b.waitForRequest((request) => request.method() === 'PUT')
  await typeAtEnd(b, FIRST, ' BBB')
  await sent

  // A types in the same paragraph and saves. B hears of it while its own editor is open on it.
  const saved = put(a, 200)
  await typeAtEnd(a, FIRST, ' AAA')
  await saved

  // Both changed the paragraph: B shows A's version, closes its editor, and keeps its own aside.
  const conflict = b.getByRole('group', { name: 'Conflict' })
  await expect(conflict).toContainText('BBB')
  await expect(editor(b)).toHaveCount(0)
  await expect(blockWith(b, 'render it again. AAA')).toHaveCount(1)
  // B's held save carries the old base and is refused. Nothing of B's reaches the file, and B
  // has no draft left to save back, so A's editor, still open, hears nothing more.
  const refused = put(b, 409)
  release()
  await refused
  expect(app.readArticle()).toMatch(/render it again\. AAA/)
  expect(app.readArticle()).not.toContain('BBB')
  await expect(editor(a)).toContainText('render it again. AAA')
  await expect(notice(a)).toHaveCount(0)

  // B keeps both: A's paragraph, then B's. A hears of it and shows both, its editor still open.
  const merged = put(b, 200)
  await conflict.getByRole('button', { name: 'Keep both' }).click()
  await merged
  await expect(blockWith(a, 'render it again. BBB')).toHaveCount(1)
  await expect(editor(a)).toContainText('render it again. AAA')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toMatch(/render it again\. AAA\n\nThis is a sample article\.[^\n]*BBB/)
  })
  // One save each, plus B's refused one and its choice: nothing went back and forth.
  expect(savesOfA()).toBe(1)
  expect(savesOfB()).toBe(2)
})

test('a block finished before its autosave survives another tab’s save arriving (#30)', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await bothOpen(a, b)

  // Hold B's save until B has pressed Esc, so the edit is committed but not yet on disk: the same
  // state as pressing Esc within the 750 ms autosave debounce, without depending on timing.
  const release = await holdSaves(b)
  const sent = b.waitForRequest((request) => request.method() === 'PUT')
  await typeAtEnd(b, SECOND, ' BBB')
  expect((await sent).postData()).toContain('stays plain markdown. BBB')
  await b.keyboard.press('Escape')
  await expect(editor(b)).toHaveCount(0)

  // A saves another paragraph; B merges it in and keeps its finished edit, and says so.
  await aSavesFirstParagraph(a, app)
  await expect(blockWith(b, 'render it again. AAA')).toHaveCount(1)
  await expect(blockWith(b, 'stays plain markdown. BBB')).toHaveCount(1)
  await expect(notice(b)).toContainText('Your unsaved text was kept.')

  // B's held save is refused; the merged text is saved after it.
  const refused = put(b, 409)
  const saved = put(b, 200)
  release()
  await refused
  await saved
  await expectFile(app.articlePath(), (file) => {
    expect(file).toMatch(/render it again\. AAA/)
    expect(file).toContain('stays plain markdown. BBB')
  })
})
