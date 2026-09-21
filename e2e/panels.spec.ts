import { expect, test } from './fixtures.ts'
import { ask, blockWith, expectOneWaiting, openArticle, selectWord, tray } from './helpers.ts'

test('Enter on a focused button activates it instead of entering the document', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper make it louder')
  await expectOneWaiting(app)

  const summary = tray(page).getByRole('button').first()
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(tray(page)).toContainText('fake:upper make it louder')
  await expect(summary).toBeFocused()
})
