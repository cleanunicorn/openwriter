import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
/** End of the whole block; plain `End` stops at the end of the wrapped visual line. */
export const blockEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
export const blockStart = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'

export const blocks = (page: Page): Locator => page.getByTestId('block')
export const blockWith = (page: Page, text: string | RegExp): Locator =>
  blocks(page).filter({ hasText: text })
export const editor = (page: Page): Locator => page.getByRole('textbox', { name: 'Block editor' })
/** dnd-kit also renders a `status` live region, so the notice is addressed by name. */
export const notice = (page: Page): Locator => page.getByRole('status', { name: 'Document notice' })

/** Open the app and wait until the sample article is on screen. */
export async function openArticle(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })).toBeVisible()
}

/** Text of every rendered block, in document order (front matter excluded). */
export async function blockTexts(page: Page): Promise<string[]> {
  const texts = await page
    .locator('[data-testid="block"][data-kind="content"] .block-body')
    .allInnerTexts()
  return texts.map((text) => text.trim().split('\n')[0] ?? '')
}

/**
 * Move a block with dnd-kit's keyboard sensor. Each step waits for the screen-reader
 * announcement of the previous one, so the test never outruns the sensor and never sleeps.
 */
export async function keyboardMove(
  page: Page,
  block: Locator,
  key: 'ArrowUp' | 'ArrowDown',
): Promise<void> {
  const announcements = page.locator('[aria-live="assertive"]')
  await block.hover()
  await block.getByTestId('drag-handle').focus()
  await page.keyboard.press('Space')
  await expect(announcements).toContainText('Draggable item')
  const pickedUp = await announcements.innerText()
  await page.keyboard.press(key)
  await expect(announcements).not.toHaveText(pickedUp)
  await page.keyboard.press('Space')
  await expect(announcements).toContainText('was dropped')
}

/** Autosave is debounced, so file assertions poll instead of sleeping. */
export async function expectFile(path: string, check: (text: string) => void): Promise<void> {
  await expect(() => check(readFileSync(path, 'utf8'))).toPass({ timeout: 5000 })
}
