import { expect, test } from './fixtures.ts'
import { expectFile, expectWaiting, ghosts, mod, openArticle, release } from './helpers.ts'

test('a research answer opens in a side panel and a note can be inserted as a block', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await expect(page.getByRole('complementary')).toHaveCount(0)

  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('research')
  await page.keyboard.press('Enter')
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

  await panel.getByRole('button', { name: 'Done with these notes' }).click()
  await expect(page.getByRole('complementary')).toHaveCount(0)
})
