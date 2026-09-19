import { expect, test } from './fixtures.ts'
import { blockTexts, blockWith, expectFile, keyboardMove, openArticle } from './helpers.ts'

test('the drag handle appears on hover and reorders blocks with the keyboard', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const heading = blockWith(page, 'What is next')
  await heading.hover()
  const handle = heading.getByTestId('drag-handle')
  await expect(handle).toBeVisible()

  await keyboardMove(page, heading, 'ArrowDown')

  await expect(async () => {
    const texts = await blockTexts(page)
    expect(texts.indexOf('What is next')).toBe(
      texts.indexOf(
        'Select some text, type an instruction, and keep writing while the agent works.',
      ) + 1,
    )
  }).toPass()
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('while the agent works.\n\n## What is next\n\nResults arrive'),
  )
})

test('dragging a block by its handle with the mouse moves it', async ({ page, app }) => {
  await openArticle(page)
  const source = blockWith(page, 'Results arrive as ghost diffs')
  const target = blockWith(page, 'What is next')
  await source.hover()
  const handle = await source.getByTestId('drag-handle').boundingBox()
  const destination = await target.boundingBox()
  if (handle === null || destination === null) throw new Error('no box')

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 10, { steps: 5 })
  await page.mouse.move(destination.x + 60, destination.y + 2, { steps: 15 })
  await page.mouse.up()

  await expect(async () => {
    const texts = await blockTexts(page)
    expect(
      texts.indexOf(
        'Results arrive as ghost diffs in place. Accept what you like and reject the rest.',
      ),
    ).toBeLessThan(
      texts.indexOf(
        'Select some text, type an instruction, and keep writing while the agent works.',
      ),
    )
  }).toPass()
  await expectFile(app.articlePath(), (file) =>
    expect(file.indexOf('Results arrive')).toBeLessThan(file.indexOf('Select some text')),
  )
})

test('the front matter has no drag handle', async ({ page }) => {
  await openArticle(page)
  const frontMatter = page.locator('[data-testid="block"][data-kind="frontmatter"]')
  await frontMatter.hover()
  await expect(frontMatter.getByTestId('drag-handle')).toHaveCount(0)
})
