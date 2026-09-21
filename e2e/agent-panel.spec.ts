import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  editor,
  expectFile,
  expectOneWaiting,
  ghosts,
  mod,
  openArticle,
  release,
  tray,
} from './helpers.ts'

const agent = (page: Page) => page.getByRole('region', { name: 'Agent', exact: true })
const message = (page: Page) => page.getByRole('textbox', { name: 'Message to the agent' })

/** Type into the right panel's message box and send it with Enter. */
async function say(page: Page, text: string): Promise<void> {
  await message(page).fill(text)
  await message(page).press('Enter')
  await expect(message(page)).toHaveValue('')
}

test('the agent panel opens empty with starters and a message box', async ({ page }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(agent(page)).toBeVisible()
  await expect(agent(page).getByRole('button', { name: /Draft brief from my notes/ })).toBeVisible()
  await expect(agent(page).getByRole('button', { name: '/diagram' })).toBeVisible()
  await expect(tray(page)).toHaveCount(0)

  await agent(page).getByRole('button', { name: '/diagram' }).click()
  await expect(message(page)).toHaveValue('/diagram ')
  await expect(message(page)).toBeFocused()
})

test('a whole-article message runs as a job, arrives as ghosts, and is accepted', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await say(page, 'fake:upper make the whole thing louder')

  await expect(tray(page)).toContainText('fake:upper make the whole thing louder')
  await expect(tray(page)).toContainText('whole article')
  await expectOneWaiting(app)
  await release(app)
  await expect(tray(page)).toContainText('ready for review')
  await expect(ghosts(page).first()).toBeVisible()

  await ghosts(page).first().getByRole('button', { name: 'Accept all' }).click()
  await expect(ghosts(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'WHY BLOCKS' })).toBeVisible()
  await expectFile(app.articlePath(), (file) => expect(file).toContain('## WHY BLOCKS\n'))
})

test('a research message answers in the agent panel without taking the keyboard', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await agent(page).getByRole('combobox', { name: 'Ask about' }).selectOption('research')
  await say(page, 'fake:research what do my notes say?')
  await expectOneWaiting(app)

  await page.getByText('This is a sample article.').click()
  await release(app)
  const notes = agent(page).getByRole('complementary', { name: 'Research notes' })
  await expect(notes).toContainText('Answered the question.')
  await expect(editor(page)).toBeFocused()
  await expect(ghosts(page)).toHaveCount(0)
})

test('the message box keeps an unsent draft when the panel closes', async ({ page }) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await message(page).fill('half a thought')
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(agent(page)).toHaveCount(0)
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(message(page)).toHaveValue('half a thought')
})
