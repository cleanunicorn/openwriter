import { existsSync, readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'
import {
  answer,
  articleHeading,
  boundingBox,
  editor,
  expectFile,
  expectOneWaiting,
  expectWaiting,
  ghosts,
  jobFile,
  mod,
  openArticle,
  release,
  runCommand,
  tray,
  waitingJobs,
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

test('a follow-up carries the earlier turn; a new conversation starts clean', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await say(page, 'fake:upper rewrite the intro')
  const first = await expectOneWaiting(app)
  await release(app, first)
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()
  await expect(ghosts(page)).toHaveCount(0)
  await expect(agent(page)).toContainText('Carries the last 1 turn about this document.')

  await say(page, 'make it shorter')
  const second = await expectOneWaiting(app)
  const conversation = readFileSync(jobFile(app, second, 'conversation.md'), 'utf8')
  expect(conversation).toContain('rewrite the intro')
  expect(conversation).toContain('rejected')
  expect(readFileSync(jobFile(app, second, 'instruction.md'), 'utf8')).toContain(
    `.zen/jobs/${second}/conversation.md`,
  )
  // The first turn's directory is exactly what a job always had.
  expect(existsSync(jobFile(app, first, 'conversation.md'))).toBe(false)
  expect(readFileSync(jobFile(app, first, 'instruction.md'), 'utf8')).not.toContain(
    'conversation.md',
  )

  await release(app, second)
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()
  await agent(page).getByRole('button', { name: 'New conversation' }).click()
  await expect(agent(page).getByRole('button', { name: 'New conversation' })).toHaveCount(0)
  await say(page, 'start over')
  const third = await expectOneWaiting(app)
  expect(existsSync(jobFile(app, third, 'conversation.md'))).toBe(false)
})

test('on a narrow window the job count stays in sight while the agent panel is below the article', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(agent(page)).toHaveAttribute('data-layout', 'stacked')
  await page.evaluate(() => window.scrollTo(0, 0))
  await say(page, 'fake:upper make it louder')
  await expectOneWaiting(app)

  await page.evaluate(() => window.scrollTo(0, 0))
  // Two copies of the count while stacked: the transcript's, then the corner's (last in the page).
  const count = page.getByRole('button', { name: '1 running' }).last()
  await expect(count).toBeInViewport()
  await expect(page.getByRole('region', { name: 'Agent jobs' })).toHaveCount(1)
  await count.click()
  await expect(agent(page)).toBeInViewport()
})

test('opening the agent panel by hand on a narrow window brings it into view, keyboard kept', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await openArticle(page)
  await page.getByText('This is a sample article.').click()
  await expect(editor(page)).toBeFocused()
  await page.keyboard.press(`${mod}+Alt+b`)
  await expect(agent(page)).toBeInViewport()
  await expect(editor(page)).toBeFocused()
})

test('an unsent message belongs to its document and is sent against it', async ({ page, app }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  await message(page).fill('fake:upper for the first article')

  const files = page.getByRole('navigation', { name: 'Files and actions' })
  await files.getByRole('button', { name: 'New article…' }).click()
  await answer(page, 'Article title', 'Second Thoughts')
  await expect(articleHeading(page, 'Second Thoughts')).toBeVisible()
  await expect(message(page)).toHaveValue('')

  await files.getByRole('button', { name: 'Hello, openwrite' }).click()
  await expect(articleHeading(page)).toBeVisible()
  await expect(message(page)).toHaveValue('fake:upper for the first article')
  await message(page).press('Enter')
  const id = await expectOneWaiting(app)
  const job = (await (await fetch(`${app.url}/api/jobs/${id}`)).json()) as {
    doc: { slug: string }
  }
  expect(job.doc.slug).toBe('hello-openwrite')
})

test('the draft starters stay one click away once the conversation has turns', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  const brief = agent(page).getByRole('button', { name: 'Draft brief from my notes' })
  await expect(brief).toBeVisible()
  await say(page, 'fake:upper make it louder')
  await expectOneWaiting(app)
  await expect(tray(page)).toContainText('make it louder')
  await expect(brief).toBeVisible()
  await expect(agent(page).getByRole('button', { name: 'Draft article from brief' })).toBeVisible()
})

test('a /skill message from the agent panel runs that skill with its own scope', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await say(page, '/diagram draw the pipeline')
  const id = await expectOneWaiting(app)
  const instruction = readFileSync(jobFile(app, id, 'instruction.md'), 'utf8')
  expect(instruction).toContain('## Skill: diagram')
  expect(instruction).toContain('draw the pipeline')
  // diagram is a blocks-scope skill: the composer's "whole article" does not override it.
  expect(JSON.parse(readFileSync(jobFile(app, id, 'targets.json'), 'utf8')).scope).toBe('blocks')
  await expect(tray(page)).toContainText('/diagram')
})

test('a ready turn offers "Review", naming the document only when it is another one', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await say(page, 'fake:upper make it louder')
  await expectOneWaiting(app)
  await release(app)
  await expect(tray(page).getByRole('button', { name: 'Review', exact: true })).toBeVisible()

  await page.keyboard.press(`${mod}+b`)
  await page
    .getByRole('navigation', { name: 'Files and actions' })
    .getByRole('button', { name: 'strategy.md' })
    .click()
  await expect(
    tray(page).getByRole('button', { name: 'Review in Hello, openwrite', exact: true }),
  ).toBeVisible()
  await expect(tray(page)).not.toContainText('article:')
})

test('a message held behind a running job carries what became of that job', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await say(page, 'fake:upper rewrite the intro')
  const first = await expectOneWaiting(app)
  // A whole-article job runs alone: this one is held until the first is decided.
  await say(page, 'make it shorter')
  await expect(tray(page)).toContainText('queued behind another job')

  await release(app, first)
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()
  const [second] = (await expectWaiting(app, 1)).filter((id) => id !== first)
  if (second === undefined) throw new Error('the held message never started')
  const conversation = readFileSync(jobFile(app, second, 'conversation.md'), 'utf8')
  // Picked when it was posted, not when it was typed: the first turn is decided, not running.
  expect(conversation).toContain('— rejected')
  expect(conversation).not.toContain('still running')
})

test('Escape in the message box hands the keyboard back and keeps the panel and the draft', async ({
  page,
}) => {
  await openArticle(page)
  const agentHandle = page.getByRole('button', { name: 'Agent', exact: true })
  await agentHandle.focus()
  await page.keyboard.press('Enter')
  await expect(agent(page)).toBeVisible()
  await expect(agentHandle).toBeFocused()

  await message(page).focus()
  await page.keyboard.type('half a thought')
  await page.keyboard.press('Escape')
  await expect(agentHandle).toBeFocused()
  await expect(agent(page)).toBeVisible()
  await expect(message(page)).toHaveValue('half a thought')
})

test("a new conversation about one document leaves another document's conversation alone", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  const files = page.getByRole('navigation', { name: 'Files and actions' })

  await say(page, 'fake:upper rewrite the intro')
  await release(app, await expectOneWaiting(app))
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()
  await expect(agent(page)).toContainText('Carries the last 1 turn about this document.')

  await files.getByRole('button', { name: 'strategy.md' }).click()
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  await say(page, 'fake:upper tighten the strategy')
  await release(app, await expectOneWaiting(app))
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()
  await agent(page).getByRole('button', { name: 'New conversation' }).click()
  await expect(agent(page).getByRole('button', { name: 'New conversation' })).toHaveCount(0)

  await files.getByRole('button', { name: 'Hello, openwrite' }).click()
  await expect(articleHeading(page)).toBeVisible()
  await expect(agent(page)).toContainText('Carries the last 1 turn about this document.')
})

test('Shift+Enter in the message box starts a new line; Enter sends it once', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+Alt+b`)
  await message(page).fill('fake:upper first line')
  await message(page).press('Shift+Enter')
  await message(page).pressSequentially('second line')
  await expect(message(page)).toHaveValue('fake:upper first line\nsecond line')
  expect(await waitingJobs(app)).toEqual([])

  await message(page).press('Enter')
  await expect(message(page)).toHaveValue('')
  await expectOneWaiting(app)
  await expect(tray(page).getByRole('listitem')).toHaveCount(1)
})

test('"Go to agent" gives the keyboard to the agent panel even in an empty workspace', async ({
  page,
}) => {
  await openArticle(page)
  await runCommand(page, 'new workspace')
  await answer(page, 'New workspace name', 'empty')
  await expect(page.getByText('No article yet')).toBeVisible()
  // Every control in the panel is disabled here: the panel itself takes the keyboard.
  await runCommand(page, 'go to agent')
  await expect(agent(page)).toBeFocused()
  // …and a keyboard user can see where it went.
  await expect(agent(page)).not.toHaveCSS('outline-style', 'none')
})

test('a turn about another document says which one', async ({ page, app }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  await say(page, 'fake:upper rewrite the intro')
  await release(app, await expectOneWaiting(app))
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()
  // On its own document the turn needs no label.
  await expect(tray(page)).not.toContainText('Hello, openwrite')

  await page
    .getByRole('navigation', { name: 'Files and actions' })
    .getByRole('button', { name: 'strategy.md' })
    .click()
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  await expect(tray(page).getByRole('listitem')).toContainText('Hello, openwrite')
})

test('a long document title in a turn is cut short, never crowding out the instruction', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await openArticle(page)
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.press(`${mod}+Alt+b`)
  const files = page.getByRole('navigation', { name: 'Files and actions' })
  const title = `A very long title ${'that keeps on going '.repeat(8)}end`
  await files.getByRole('button', { name: 'New article…' }).click()
  await answer(page, 'Article title', title)
  await expect(articleHeading(page, title)).toBeVisible()
  await say(page, 'fake:upper tidy')
  await release(app, await expectOneWaiting(app))
  await ghosts(page).first().getByRole('button', { name: 'Reject all' }).click()

  await files.getByRole('button', { name: 'strategy.md' }).click()
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  const chip = tray(page).getByTitle(title)
  await expect(chip).toBeVisible()
  const panel = await boundingBox(agent(page))
  const chipBox = await boundingBox(chip)
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(panel.x + panel.width)
  const instruction = await boundingBox(tray(page).getByText('fake:upper tidy'))
  expect(instruction.width).toBeGreaterThan(40)
})
