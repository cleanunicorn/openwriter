import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { strFromU8 } from 'fflate'
import { expect, test } from './fixtures.ts'
import { articleHeading, exportVia, notice, openArticle, runCommand } from './helpers.ts'

test('markdown export is the bundle as is, including an unsaved edit', async ({ page, app }) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' exported')
  // Still in the editor: the export commits and saves first.
  const { name, files } = await exportVia(page, 'export markdown')
  expect(name).toBe('hello-openwrite-markdown.zip')
  expect(Object.keys(files).sort()).toEqual([
    'hello-openwrite/index.md',
    'hello-openwrite/pixel.png',
  ])
  const markdown = strFromU8(files['hello-openwrite/index.md'] as Uint8Array)
  expect(markdown).toContain('## Why blocks exported')
  expect(markdown).toBe(app.readArticle())
})

test('HTML export is standalone: diagrams rendered, local stylesheet and assets, works offline', async ({
  page,
  context,
}) => {
  await openArticle(page)
  const { files, dir } = await exportVia(page, 'export html')
  expect(Object.keys(files).sort()).toEqual([
    'hello-openwrite/index.html',
    'hello-openwrite/pixel.png',
    'hello-openwrite/style.css',
  ])
  const html = strFromU8(files['hello-openwrite/index.html'] as Uint8Array)
  expect(html).toContain('<title>Hello, openwrite</title>')
  expect(html).not.toMatch(/<script|data-line|data-testid|class="shortcode"/)
  expect(html).not.toContain('{{<')
  // The shortcode's tags are dropped, its content kept.
  expect(html).toContain('A paired Hugo shortcode stays one block.')
  expect(html).toContain('hljs-keyword')

  // Open the extracted page from disk with the network cut off.
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), data)
  }
  await context.route(/^https?:/, (route) => route.abort())
  const offline = await context.newPage()
  await offline.goto(pathToFileURL(path.join(dir, 'hello-openwrite', 'index.html')).href)
  await expect(articleHeading(offline)).toBeVisible()
  // A class on purpose: the exported file's contract is to carry no test ids (asserted below).
  await expect(offline.locator('.diagram svg')).toContainText('Writer')
  expect(
    await offline
      .locator('img[alt="A quiet pixel"]')
      .evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBe(1)
  expect(await offline.locator('main').evaluate((main) => getComputedStyle(main).width)).toBe(
    '680px',
  )
  expect(await offline.locator('[data-testid="drag-handle"], button').count()).toBe(0)
})

test('a diagram that cannot render fails the export with a message', async ({ page, app }) => {
  writeFileSync(app.articlePath(), '# Broken\n\n```mermaid\nthis is not a diagram\n```\n')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Broken' })).toBeVisible()
  await runCommand(page, 'export html')
  await expect(notice(page)).toContainText('diagram could not be rendered')
})
