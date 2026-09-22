import type { Page } from '@playwright/test'
import { type App, expect, test } from './fixtures.ts'
import { blockEnd, blockWith, editor, expectFile, notice, openArticle } from './helpers.ts'

/**
 * Two tabs on the same article are unsupported (README, "Two tabs on the same article"). These
 * tests pin down what actually happens, so the documentation stays true. Two of them assert known
 * bugs (#29, #30): when one is fixed, its test here is the one to flip.
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

/** Both tabs open on the article; tab A has saved ` AAA` at the end of the first paragraph. */
async function aSavedFirstParagraph(a: Page, b: Page, app: App): Promise<void> {
  await openArticle(a)
  await openArticle(b)
  const saved = put(a, 200)
  await typeAtEnd(a, FIRST, ' AAA')
  await saved
  await a.keyboard.press('Escape')
  await expectFile(app.articlePath(), (file) => expect(file).toMatch(/render it again\. AAA/))
}

test('a second tab learns of another tab’s save only when its own save is refused', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await aSavedFirstParagraph(a, b, app)

  // B was never told: its first save still carries the old base, so the server refuses it (409).
  const refused = put(b, 409)
  const merged = put(b, 200)
  await typeAtEnd(b, SECOND, ' BBB')
  await refused

  // The refusal reloads B from disk. A's paragraph comes in, B's open block keeps its text…
  await expect(notice(b)).toContainText('Reloaded: the file changed on disk.')
  await expect(blockWith(b, 'render it again. AAA')).toHaveCount(1)
  await expect(editor(b)).toContainText('stays plain markdown. BBB')
  // …and the next save writes both. Different blocks merge.
  await merged
  await expectFile(app.articlePath(), (file) => {
    expect(file).toMatch(/render it again\. AAA/)
    expect(file).toContain('stays plain markdown. BBB')
  })

  // A is not told about B's save either; reloading the tab is what brings it in.
  await expect(notice(a)).toHaveCount(0)
  await expect(blockWith(a, 'stays plain markdown. BBB')).toHaveCount(0)
  await a.reload()
  await expect(blockWith(a, 'stays plain markdown. BBB')).toHaveCount(1)
})

test('the same block edited in two tabs: the stale tab’s copy replaces the other’s (#29)', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await aSavedFirstParagraph(a, b, app)

  // B edits the paragraph A just saved, starting from its stale copy (no AAA).
  const refused = put(b, 409)
  const overwrote = put(b, 200)
  await typeAtEnd(b, FIRST, ' BBB')
  await refused
  // The reload keeps the block B is typing in, so B's copy wins that block and is saved.
  await expect(notice(b)).toContainText('Reloaded: the file changed on disk.')
  await overwrote
  await expectFile(app.articlePath(), (file) => {
    expect(file).toMatch(/render it again\. BBB/)
    expect(file).not.toContain('AAA')
  })

  // A's text is gone from the file, and A is not told: no notice, and its screen still has it.
  await expect(notice(a)).toHaveCount(0)
  await expect(blockWith(a, 'render it again. AAA')).toHaveCount(1)
})

test('a block finished before its autosave is dropped by the reload a refused save causes (#30)', async ({
  page: a,
  context,
  app,
}) => {
  const b = await context.newPage()
  await aSavedFirstParagraph(a, b, app)

  // Hold B's save until B has pressed Esc, so the edit is committed but not yet on disk: the same
  // state as pressing Esc within the 750 ms autosave debounce, without depending on timing.
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await b.route('**/api/docs/**', async (route) => {
    if (route.request().method() === 'PUT') await held
    await route.continue()
  })
  const sent = b.waitForRequest((request) => request.method() === 'PUT')
  const refused = put(b, 409)
  await typeAtEnd(b, SECOND, ' BBB')
  expect((await sent).postData()).toContain('stays plain markdown. BBB')
  await b.keyboard.press('Escape')
  await expect(editor(b)).toHaveCount(0)
  release()
  await refused

  // The reload takes the disk's copy of every block that is not open, B's finished edit included.
  await expect(notice(b)).toContainText('Reloaded: the file changed on disk.')
  await expect(blockWith(b, 'render it again. AAA')).toHaveCount(1)
  await expect(blockWith(b, 'stays plain markdown. BBB')).toHaveCount(0)
  expect(app.readArticle()).not.toContain('BBB')
})
