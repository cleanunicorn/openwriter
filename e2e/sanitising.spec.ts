import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'fflate'
import { expect, test } from './fixtures.ts'
import {
  acceptButton,
  ask,
  blockWith,
  expectWaiting,
  ghosts,
  mod,
  openArticle,
  openPalette,
  release,
  selectWord,
} from './helpers.ts'

// Article text and agent output are both untrusted, and markdown-it runs with `html: true`:
// DOMPurify in renderMarkdown is the one thing between a pasted snippet and the loopback API.
const HOSTILE = [
  'Hostile <img src="x" onerror="window.__xss = \'img\'"> block',
  '<script>window.__xss = "script"</script>',
  '<a href="javascript:window.__xss=\'href\'">click</a>',
  '<iframe src="javascript:window.__xss=\'iframe\'"></iframe>',
  '<svg onload="window.__xss=\'svg\'"></svg>',
  '[md link](javascript:window.__xss=1)',
].join(' ')

async function expectInert(page: Page, scope = page.getByRole('main')) {
  expect(await page.evaluate(() => (window as unknown as { __xss?: string }).__xss)).toBeUndefined()
  for (const selector of [
    'script',
    'iframe',
    '[onerror]',
    '[onload]',
    'a[href^="javascript:" i]',
  ]) {
    await expect(scope.locator(selector)).toHaveCount(0)
  }
}

async function typeHostileBlock(page: Page) {
  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.insertText(HOSTILE)
  await page.keyboard.press('Escape')
  await expect(blockWith(page, 'Hostile')).toBeVisible()
}

test('hostile markup typed into a block renders inert', async ({ page }) => {
  await openArticle(page)
  await typeHostileBlock(page)
  // The harmless parts survive, the dangerous ones do not.
  await expect(blockWith(page, 'Hostile').locator('img')).toHaveCount(1)
  await expectInert(page)
})

test('hostile markup in an agent result renders inert in the ghost and after accept', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await typeHostileBlock(page)
  await selectWord(page, blockWith(page, 'Hostile'), 'Hostile')
  await ask(page, 'fake:echo')
  await expectWaiting(app, 1)
  await release(app)
  await expect(ghosts(page)).toContainText('Hostile')
  await expectInert(page)
  await acceptButton(ghosts(page)).click()
  await expect(blockWith(page, 'Hostile')).toHaveCount(2)
  await expectInert(page)
})

test('the standalone HTML export carries none of it', async ({ page }) => {
  await openArticle(page)
  await typeHostileBlock(page)
  await openPalette(page, 'export html')
  const download = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  const saved = path.join(mkdtempSync(path.join(os.tmpdir(), 'openwrite-xss-')), 'export.zip')
  await (await download).saveAs(saved)
  const html = strFromU8(
    unzipSync(new Uint8Array(readFileSync(saved)))['hello-openwrite/index.html'] as Uint8Array,
  )
  expect(html).toContain('Hostile')
  // markdown-it refuses to turn `[x](javascript:…)` into a link, so that one stays as plain text.
  expect(html).not.toMatch(/<script|<iframe|onerror|onload|(href|src)\s*=\s*["']?\s*javascript:/i)
})
