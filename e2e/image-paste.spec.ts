import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import { blockEnd, editor, expectFile, openArticle } from './helpers.ts'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9Qz0AEYBxVSF8FAFi2A/0tT9i7AAAAAElFTkSuQmCC'

/** Headless Chromium cannot put an image on the real clipboard, so the paste event is synthetic. */
async function pasteImage(page: import('@playwright/test').Page, name: string, type: string) {
  await editor(page).evaluate(
    (element, { base64, fileName, mime }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], fileName, { type: mime }))
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { base64: PNG, fileName: name, mime: type },
  )
}

test('pasting an image saves it into the bundle and inserts a relative reference', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' ')
  await pasteImage(page, 'Screen Shot.png', 'image/png')

  await expect(editor(page)).toContainText('![](screen-shot.png)')
  const bundle = path.dirname(app.articlePath())
  expect(existsSync(path.join(bundle, 'screen-shot.png'))).toBe(true)

  await page.keyboard.press('Escape')
  // Rendered through the asset route, stored as a plain relative path.
  await expect(page.locator('img[src$="/assets/screen-shot.png"]')).toBeVisible()
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('reject the rest. ![](screen-shot.png)'),
  )
})

test('a pasted file that is not an image is not uploaded', async ({ page, app }) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  const before = readdirSync(path.dirname(app.articlePath())).sort()
  await pasteImage(page, 'notes.txt', 'text/plain')
  await page.keyboard.type('still typing')
  await expect(editor(page)).toContainText('still typing')
  expect(readdirSync(path.dirname(app.articlePath())).sort()).toEqual(before)
})
