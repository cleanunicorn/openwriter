import { expect, test } from './fixtures.ts'
import { blockEnd, expectFile, notice, openArticle } from './helpers.ts'

test('a failed save is announced where the writer is, not at the top of a long article', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.route('**/api/docs/article/**', (route) =>
    route.request().method() === 'PUT' ? route.abort('failed') : route.continue(),
  )
  // Work at the very end of the article, scrolled far away from the top.
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' This will not reach the disk.')
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200)

  await expect(notice(page)).toContainText('Could not save')
  await expect(notice(page)).toBeInViewport()

  // Saving retries by itself once the server answers again, without another keystroke.
  await page.unroute('**/api/docs/article/**')
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('This will not reach the disk.'),
  )
  await notice(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice(page)).toHaveCount(0)
})
