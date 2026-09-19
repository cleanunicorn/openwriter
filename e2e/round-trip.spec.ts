import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import { editor, expectFile, openArticle } from './helpers.ts'

test('an untouched article is never written', async ({ page, app }) => {
  const before = readFileSync(app.articlePath())
  const mtime = statSync(app.articlePath()).mtimeMs
  await openArticle(page)
  // Enter and leave edit mode without changing anything, then give autosave a chance to misfire.
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('diagram').locator('svg')).toBeVisible()
  await expect(() => expect(statSync(app.articlePath()).mtimeMs).toBe(mtime)).toPass()
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveCount(0)

  expect(statSync(app.articlePath()).mtimeMs).toBe(mtime)
  expect(readFileSync(app.articlePath()).equals(before)).toBe(true)
})

test('a paired shortcode survives editing of its neighbours, byte for byte', async ({
  page,
  app,
}) => {
  const shortcode =
    '{{< notice tip >}}\nA paired Hugo shortcode stays one block.\n\nEven when it has several paragraphs inside.\n{{< /notice >}}'
  expect(app.readArticle()).toContain(shortcode)
  await openArticle(page)

  await page.getByRole('heading', { name: 'A shortcode that spans blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (edited)')
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: 'Code and diagrams' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (edited)')
  await page.keyboard.press('Escape')

  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('## Code and diagrams (edited)')
    expect(file).toContain(
      `## A shortcode that spans blocks (edited)\n\n${shortcode}\n\n## Code and diagrams (edited)`,
    )
  })
  // Only the two edited lines differ from the original: the tracked sample, not this test's copy.
  const original = readFileSync(
    path.join(import.meta.dirname, '..', 'sample-workspace/content/posts/hello-openwrite/index.md'),
    'utf8',
  )
  expect(app.readArticle().replaceAll(' (edited)', '')).toBe(original)
})

test('the whole shortcode is one block in the editor', async ({ page }) => {
  await openArticle(page)
  await page.getByText('A paired Hugo shortcode stays one block.').click()
  await expect(editor(page)).toContainText('{{< notice tip >}}')
  await expect(editor(page)).toContainText('{{< /notice >}}')
})
