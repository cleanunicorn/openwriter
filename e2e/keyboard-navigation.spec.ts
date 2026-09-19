import { expect, test } from './fixtures.ts'
import { blockStart, blocks, editor, expectFile, openArticle } from './helpers.ts'

test('arrow keys cross block edges in edit mode', async ({ page }) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await expect(editor(page)).toHaveText('## Why blocks')

  await page.keyboard.press('ArrowDown')
  await expect(editor(page)).toContainText('Every paragraph, list')
  // Arriving from above puts the cursor at the start.
  await page.keyboard.type('¦')
  await expect(editor(page)).toContainText('¦Every paragraph')
  await page.keyboard.press('Backspace')

  await page.keyboard.press('ArrowUp')
  await expect(editor(page)).toHaveText('## Why blocks')
  // Arriving from below puts the cursor at the end.
  await page.keyboard.type('¦')
  await expect(editor(page)).toHaveText('## Why blocks¦')
})

test('Enter on an empty last line creates a new block', async ({ page, app }) => {
  await openArticle(page)
  const before = await blocks(page).count()
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveText('')
  await page.keyboard.type('A brand new paragraph.')
  await page.keyboard.press('Escape')

  await expect(blocks(page)).toHaveCount(before + 1)
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('## Why blocks\n\nA brand new paragraph.\n\nEvery paragraph'),
  )
})

test('Enter inside an open code fence does not split the block', async ({ page }) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('```')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toContainText('```')
  await expect(editor(page)).toContainText('## Why blocks')
})

test('Backspace at the start of a block merges it into the previous one', async ({ page, app }) => {
  await openArticle(page)
  const before = await blocks(page).count()
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockStart)
  await page.keyboard.press('Backspace')

  await expect(editor(page)).toContainText('Select some text')
  await expect(editor(page)).toContainText('Results arrive')
  // The cursor sits at the join.
  await page.keyboard.type('¦')
  await expect(editor(page)).toContainText('¦Results arrive')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  await expect(blocks(page)).toHaveCount(before - 1)
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('while the agent works.\nResults arrive as ghost diffs'),
  )
})
