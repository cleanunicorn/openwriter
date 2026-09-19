import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { blockEnd, editor, expectFile, notice, openArticle } from './helpers.ts'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9Qz0AEYBxVSF8FAFi2A/0tT9i7AAAAAElFTkSuQmCC'

/**
 * Headless Chromium cannot put an image on the real clipboard or drag a file in from outside, so
 * the paste or drop event is synthetic.
 */
async function sendFile(page: Page, kind: 'paste' | 'drop', fileName: string, mimeType: string) {
  await editor(page).evaluate(
    (element, { kind, base64, fileName, mime }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], fileName, { type: mime }))
      element.dispatchEvent(
        kind === 'drop'
          ? new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
          : new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { kind, base64: PNG, fileName, mime: mimeType },
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
  await sendFile(page, 'paste', 'Screen Shot.png', 'image/png')

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
  await sendFile(page, 'paste', 'notes.txt', 'text/plain')
  await page.keyboard.type('still typing')
  await expect(editor(page)).toContainText('still typing')
  expect(readdirSync(path.dirname(app.articlePath())).sort()).toEqual(before)
})

test('dropping an image onto the editor saves it and inserts a relative reference', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' ')
  await sendFile(page, 'drop', 'Dropped Diagram.png', 'image/png')

  await expect(editor(page)).toContainText('![](dropped-diagram.png)')
  expect(existsSync(path.join(path.dirname(app.articlePath()), 'dropped-diagram.png'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('img[src$="/assets/dropped-diagram.png"]')).toBeVisible()
  await expectFile(app.articlePath(), (file) => expect(file).toContain('![](dropped-diagram.png)'))
})

test('an upload that finishes after its editor closed says where the image went', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)

  let finish: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  await page.route('**/api/docs/article/*/assets', async (route) => {
    const response = await route.fetch()
    await held
    await route.fulfill({ response })
  })
  await sendFile(page, 'paste', 'late.png', 'image/png')
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveCount(0)
  finish()

  // The file is stored; the reference cannot be typed into a closed editor, so the writer is told.
  await expect(notice(page)).toContainText('saved as late.png')
  expect(existsSync(path.join(path.dirname(app.articlePath()), 'late.png'))).toBe(true)
  expect(app.readArticle()).not.toContain('late.png')
})
