import { expect, test } from './fixtures.ts'
import {
  boundingBox,
  expectFile,
  expectWaiting,
  ghosts,
  openArticle,
  release,
  runCommand,
} from './helpers.ts'

test('a research answer opens in a side panel and a note can be inserted as a block', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await expect(page.getByRole('complementary')).toHaveCount(0)

  await runCommand(page, 'research')
  await page
    .getByRole('combobox', { name: 'Research question' })
    .fill('fake:research what do my notes say about blocks?')
  await page.keyboard.press('Enter')
  await expectWaiting(app, 1)
  await release(app)

  const panel = page.getByRole('complementary', { name: 'Research notes' })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Answered the question.')
  await expect(panel.getByRole('heading', { name: 'Findings' })).toBeVisible()
  // Research never edits: no ghost diffs anywhere.
  await expect(ghosts(page)).toHaveCount(0)

  await panel.getByRole('button', { name: 'Insert as block' }).nth(1).click()
  await expect(page.getByRole('main').getByText('The notes say blocks feel calm.')).toBeVisible()
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('\n\nThe notes say blocks feel calm.\n'),
  )

  await panel.getByRole('button', { name: 'Discard these notes' }).click()
  await expect(page.getByRole('complementary')).toHaveCount(0)
})

for (const viewport of [
  { width: 1400, height: 900 },
  { width: 900, height: 900 },
]) {
  test(`research notes never cover the text being typed (${viewport.width}px wide)`, async ({
    page,
    app,
  }) => {
    await page.setViewportSize(viewport)
    await openArticle(page)
    await runCommand(page, 'research')
    await page.getByRole('combobox', { name: 'Research question' }).fill('fake:research anything')
    await page.keyboard.press('Enter')
    await expectWaiting(app, 1)

    // The writer is typing when the answer arrives.
    await page.getByText('This is a sample article.').click()
    await page.keyboard.type('typing ')
    await release(app)
    const panel = page.getByRole('complementary', { name: 'Research notes' })
    await expect(panel).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Block editor' })).toBeFocused()

    const column = await boundingBox(page.getByRole('main'))
    const notes = await boundingBox(panel)
    const besideTheText = column.x + column.width <= notes.x
    const belowTheText = column.y + column.height <= notes.y
    expect(besideTheText || belowTheText).toBe(true)
    expect(column.width).toBeGreaterThanOrEqual(Math.min(680, viewport.width - 96))
  })
}
