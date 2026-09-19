import { expect, test } from './fixtures.ts'
import { blockWith, boundingBox, editor, expectFile, openArticle } from './helpers.ts'

test('clicking a block swaps it to its raw markdown with the cursor near the click', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const paragraph = blockWith(page, 'Every paragraph, list')
  const box = await boundingBox(paragraph.getByTestId('rendered'))
  // Click in the middle of the first line.
  await page.mouse.click(box.x + box.width / 2, box.y + 12)

  await expect(editor(page)).toBeVisible()
  await expect(editor(page)).toBeFocused()
  await expect(editor(page)).toContainText('Every paragraph, list, and code fence is a block.')

  await page.keyboard.type('¦')
  const text = (await editor(page).innerText()).replace(/\s+/g, ' ')
  const at = text.indexOf('¦')
  // "Near the click": inside the first sentence, not at either end of the block.
  expect(at).toBeGreaterThan(10)
  expect(at).toBeLessThan(90)

  await expectFile(app.articlePath(), (file) => expect(file).toContain('¦'))
})

test('clicking a heading edits its markdown source, marker included', async ({ page }) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await expect(editor(page)).toHaveText('## Why blocks')
})

test('the front matter is a quiet line that edits as raw text', async ({ page }) => {
  await openArticle(page)
  const line = page.getByTestId('front-matter')
  await expect(line).toHaveText('Hello, openwrite · 2026-09-19 · #writing #markdown #hugo')
  await line.click()
  await expect(editor(page)).toContainText('title: "Hello, openwrite"')
  await expect(editor(page)).toContainText('---')
})
