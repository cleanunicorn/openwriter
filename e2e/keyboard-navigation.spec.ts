import { expect, test } from './fixtures.ts'
import {
  blockEnd,
  blockStart,
  blocks,
  blockWith,
  editor,
  expectFile,
  occurrences,
  openArticle,
} from './helpers.ts'

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

test('Enter, type, Enter leaves one paragraph, not two', async ({ page, app }) => {
  // The gesture the duplicate was reported for, and nothing else: no outside change, no
  // reload. Carrying on with a second Enter moves the editor slot below the block just made,
  // which rebuilds its editor — and a rebuild must not commit the text one more time.
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(editor(page)).toHaveText('')

  await page.keyboard.type('Hello from the writer')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')

  await expect(blockWith(page, 'Hello from the writer')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(blockWith(page, 'Hello from the writer')).toHaveCount(1)
  await expectFile(app.articlePath(), (file) => {
    expect(occurrences(file, 'Hello from the writer')).toBe(1)
  })
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
