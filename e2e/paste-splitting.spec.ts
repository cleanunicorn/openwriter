import { expect, test } from './fixtures.ts'
import { blocks, editor, expectFile, mod, openArticle } from './helpers.ts'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test('pasting three paragraphs into a block re-splits it on blur', async ({ page, app }) => {
  await openArticle(page)
  const before = await blocks(page).count()
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(`${mod}+a`)
  await page.evaluate(() =>
    navigator.clipboard.writeText('First pasted.\n\nSecond pasted.\n\nThird pasted.'),
  )
  await page.keyboard.press(`${mod}+v`)
  await expect(editor(page)).toContainText('Third pasted.')
  // Still one block while it is being edited…
  await expect(blocks(page)).toHaveCount(before)

  await page.keyboard.press('Escape')
  // …and three blocks once it renders.
  await expect(blocks(page)).toHaveCount(before + 2)
  await expect(page.getByText('Second pasted.')).toBeVisible()
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('First pasted.\n\nSecond pasted.\n\nThird pasted.\n'),
  )

  // Each piece is its own block now.
  await page.getByText('Second pasted.').click()
  await expect(editor(page)).toHaveText('Second pasted.')
})
