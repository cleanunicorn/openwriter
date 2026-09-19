import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import {
  acceptButton,
  blockEnd,
  briefPath,
  editor,
  expectFile,
  expectWaiting,
  ghosts,
  jobFile,
  openArticle,
  release,
  runCommand,
} from './helpers.ts'

test('strategy and brief open in the same block editor', async ({ page, app }) => {
  await openArticle(page)
  await runCommand(page, 'edit strategy')
  await expect(page.getByRole('heading', { name: 'Writing strategy' })).toBeVisible()
  await expect(page.getByText('strategy.md', { exact: true })).toBeVisible()

  await runCommand(page, 'edit brief')
  await expect(page.getByText('brief · hello-openwrite')).toBeVisible()
  await page.getByText('Target reader:').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' They deploy on Fridays.')
  await page.keyboard.press('Escape')
  await expectFile(briefPath(app), (file) =>
    expect(file).toContain('publishes with Hugo. They deploy on Fridays.'),
  )

  await runCommand(page, 'open article hello')
  await expect(page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })).toBeVisible()
})

test('"draft brief from my notes" is an ordinary job whose proposal lands in the brief', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const article = readFileSync(app.articlePath(), 'utf8')
  await runCommand(page, 'draft brief')
  await expect(page.getByText('brief · hello-openwrite')).toBeVisible()

  const [jobId] = await expectWaiting(app, 1)
  const dir = jobFile(app, jobId)
  const instruction = readFileSync(path.join(dir, 'instruction.md'), 'utf8')
  expect(instruction).toContain('## Skill: draft-brief')
  expect(instruction).toContain('the brief of the article `hello-openwrite`')
  // Every job prompt carries the strategy and the brief.
  expect(readFileSync(path.join(dir, 'strategy.md'), 'utf8')).toContain('# Writing strategy')
  expect(readFileSync(path.join(dir, 'brief.md'), 'utf8')).toContain('Brief: Hello, openwrite')

  await release(app)
  await expect(ghosts(page).first()).toBeVisible()
  await ghosts(page).first().getByRole('button', { name: 'Accept all' }).click()
  await expect(ghosts(page)).toHaveCount(0)
  await expectFile(briefPath(app), (file) => expect(file).toContain('# BRIEF: HELLO, OPENWRITE'))
  // Nothing reached the article.
  expect(readFileSync(app.articlePath(), 'utf8')).toBe(article)
})

test('an empty brief is drafted through the start anchor', async ({ page, app }) => {
  await openArticle(page)
  await runCommand(page, 'new article')
  await page.getByRole('combobox', { name: 'Article title' }).fill('Fresh Post')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Fresh Post', level: 1 })).toBeVisible()

  await runCommand(page, 'draft brief')
  await expect(page.getByText('brief · fresh-post')).toBeVisible()
  const [jobId] = await expectWaiting(app, 1)
  expect(readFileSync(jobFile(app, jobId, 'targets.json'), 'utf8')).toContain('"b0"')
  await release(app)
  await acceptButton(ghosts(page).first()).click()
  await expectFile(briefPath(app, 'fresh-post'), (file) =>
    expect(file).toContain('# Draft\n\nDrafted by the fake agent'),
  )
})

test('"draft article from brief" targets the article', async ({ page, app }) => {
  await openArticle(page)
  await runCommand(page, 'edit strategy')
  await runCommand(page, 'draft article')
  await expect(page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })).toBeVisible()
  const [jobId] = await expectWaiting(app, 1)
  const instruction = readFileSync(jobFile(app, jobId, 'instruction.md'), 'utf8')
  expect(instruction).toContain('## Skill: draft-article')
  expect(instruction).toContain('Scope `article`')
  // The writer keeps editing while the draft runs.
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.type('x')
  await expect(editor(page)).toContainText('x')
})
