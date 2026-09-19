import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import {
  blockTexts,
  blockWith,
  editor,
  expectFile,
  keyboardMove,
  mod,
  openArticle,
} from './helpers.ts'

test('undo and redo work across the whole document, reorders included', async ({ page, app }) => {
  await openArticle(page)
  const original = readFileSync(app.articlePath(), 'utf8')
  // The diagram block's text changes when mermaid finishes; wait for it before comparing orders.
  await expect(page.locator('.mermaid-block svg')).toBeVisible()
  const initialOrder = await blockTexts(page)

  // 1. An edit in one block.
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' first')
  await page.keyboard.press('Escape')
  // 2. A reorder somewhere else.
  await keyboardMove(page, blockWith(page, 'What is next'), 'ArrowDown')
  await expect(async () => expect(await blockTexts(page)).not.toEqual(initialOrder)).toPass()
  await page.getByRole('main').click({ position: { x: 5, y: 5 } })

  // Undo the reorder, then the edit.
  await page.keyboard.press(`${mod}+z`)
  await expect(async () =>
    expect(await blockTexts(page)).toEqual(
      initialOrder.map((t) => (t === 'Why blocks' ? 'Why blocks first' : t)),
    ),
  ).toPass()
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByRole('heading', { name: 'Why blocks', exact: true })).toBeVisible()
  await expectFile(app.articlePath(), (file) => expect(file).toBe(original))

  // Redo brings both back.
  await page.keyboard.press(`${mod}+Shift+z`)
  await page.keyboard.press(`${mod}+Shift+z`)
  await expect(page.getByRole('heading', { name: 'Why blocks first' })).toBeVisible()
  await expect(async () => expect(await blockTexts(page)).not.toEqual(initialOrder)).toPass()
})

test('inside a block undo is the editor’s; once it has nothing left the document takes over', async ({
  page,
}) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' one')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Why blocks one' })).toBeVisible()

  await page.getByText('Results arrive as ghost diffs').click()
  await page.keyboard.type('zzz')
  await page.keyboard.press(`${mod}+z`)
  await expect(editor(page)).not.toContainText('zzz')
  // Nothing left in this editor: the next undo reverts the earlier heading edit.
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByRole('heading', { name: 'Why blocks', exact: true })).toBeVisible()
})
