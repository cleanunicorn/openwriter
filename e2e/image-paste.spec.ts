import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import { blockEnd, editor, expectFile, notice, openArticle } from './helpers.ts'

/**
 * A well-formed 2×2 PNG (valid CRCs, complete zlib stream). The earlier fixture's IDAT was
 * truncated: Chromium and WebKit drew it anyway, Firefox rejected it as corrupt and laid the
 * image out at 0×0.
 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mOwzlv6H4QZYAwATeAJNRwUPzoAAAAASUVORK5CYII='

/**
 * A headless browser cannot put an image on the real clipboard or drag a file in from outside, so
 * the paste or drop event is synthetic.
 */
async function sendFile(
  page: Page,
  kind: 'paste' | 'drop',
  fileName: string,
  mimeType: string,
  base64 = PNG,
) {
  await editor(page).evaluate(
    (element, { kind, base64, fileName, mime }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], fileName, { type: mime }))
      if (kind === 'drop') {
        element.dispatchEvent(
          new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
        )
        return
      }
      // In Firefox a File passed to the ClipboardEvent constructor never reaches the handler's
      // `clipboardData`; attaching the DataTransfer to the event works in every engine.
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      element.dispatchEvent(event)
    },
    { kind, base64, fileName, mime: mimeType },
  )
}

const svg = (text: string) => Buffer.from(text).toString('base64')

test('a pasted SVG is sanitised, still renders, and the writer is told what was removed', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' ')
  const drawing = svg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="alert(1)"><script>alert(2)</script><rect width="40" height="20" fill="#3b6ea5"/></svg>',
  )
  await sendFile(page, 'paste', 'Drawing.svg', 'image/svg+xml', drawing)

  await expect(editor(page)).toContainText('![](drawing.svg)')
  await expect(notice(page)).toContainText(
    'Removed from drawing.svg for safety: onload attribute, <script>.',
  )
  const stored = readFileSync(path.join(path.dirname(app.articlePath()), 'drawing.svg'), 'utf8')
  expect(stored).not.toMatch(/script|onload/)
  expect(stored).toContain('<rect width="40" height="20" fill="#3b6ea5"/>')

  await page.keyboard.press('Escape')
  const image = page.locator('img[src$="/assets/drawing.svg"]')
  await expect(image).toBeVisible()
  // It decoded as an image: the sanitised file still renders.
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40)
})

test('an SVG that cannot be read safely is refused with a notice and nothing is stored', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByText('Results arrive as ghost diffs').click()
  const before = readdirSync(path.dirname(app.articlePath())).sort()
  const entities = svg(
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
  )
  await sendFile(page, 'paste', 'evil.svg', 'image/svg+xml', entities)

  await expect(notice(page)).toContainText(
    'Could not add the image: evil.svg was refused as an unsafe SVG: it declares entities in a DOCTYPE',
  )
  // The editor keeps working and gained no reference.
  await page.keyboard.type('still typing')
  await expect(editor(page)).toContainText('still typing')
  await expect(editor(page)).not.toContainText('evil.svg')
  expect(readdirSync(path.dirname(app.articlePath())).sort()).toEqual(before)
})

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
  // The request is held before it reaches the server rather than refetched and held after:
  // WebKit hands `route.fetch()` no body for a File upload, so the refetch arrived empty.
  await page.route('**/api/docs/article/*/assets', async (route) => {
    await held
    await route.continue()
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
