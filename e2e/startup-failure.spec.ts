import { expect, test } from './fixtures.ts'
import { articleHeading } from './helpers.ts'

test('a failed first load says so and can be retried; it never looks like an empty workspace', async ({
  page,
}) => {
  await page.route('**/api/articles', (route) => route.abort('failed'))
  await page.goto('/')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('could not load the workspace')
  await expect(page.getByText('No article yet')).toHaveCount(0)

  await page.unroute('**/api/articles')
  await alert.getByRole('button', { name: 'Retry' }).click()
  await expect(articleHeading(page)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
