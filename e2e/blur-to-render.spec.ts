import { expect, test } from './fixtures.ts'
import { blockWith, editor, expectFile, openArticle } from './helpers.ts'

test('Esc renders the block again with the edit applied', async ({ page, app }) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' matter')
  await page.keyboard.press('Escape')

  await expect(editor(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Why blocks matter', level: 2 })).toBeVisible()
  await expectFile(app.articlePath(), (file) => expect(file).toContain('## Why blocks matter\n'))
})

test('clicking away renders the block, and clicking another block edits that one', async ({
  page,
}) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await blockWith(page, 'Select some text').click()

  await expect(page.getByRole('heading', { name: 'Why blocks!' })).toBeVisible()
  await expect(editor(page)).toHaveCount(1)
  await expect(editor(page)).toContainText('Select some text')
})

test('mermaid fences render as diagrams and other fences are highlighted', async ({ page }) => {
  await openArticle(page)
  const diagram = page.getByTestId('diagram').locator('svg')
  await expect(diagram).toBeVisible()
  await expect(diagram).toContainText('Writer')
  await expect(
    // A class on purpose: highlight.js's own output is the thing under test, and it carries no test id.
    blockWith(page, 'export function serialise').locator('.hljs-keyword').first(),
  ).toBeVisible()
})
