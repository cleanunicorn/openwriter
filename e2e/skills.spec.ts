import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import {
  acceptButton,
  answer,
  ask,
  blockWith,
  expectFile,
  expectOneWaiting,
  ghosts,
  jobFile,
  mod,
  notice,
  openArticle,
  release,
  runCommand,
  selectWord,
  tray,
} from './helpers.ts'

test('a skill from the palette runs as an ordinary job; the diagram renders in the ghost and after accept', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await runCommand(page, 'run skill diagram')
  await answer(page, 'Instruction for the diagram skill', 'fake:diagram from idea to post')

  const jobId = await expectOneWaiting(app)
  const instruction = readFileSync(jobFile(app, jobId, 'instruction.md'), 'utf8')
  expect(instruction).toContain('## Skill: diagram')
  await release(app)

  // The editor has no diagram feature: the job returned a block, and blocks with mermaid render.
  await expect(ghosts(page).getByTestId('diagram').locator('svg')).toContainText('Draft')
  await acceptButton(ghosts(page)).click()
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain('```mermaid\ngraph TD\n  Idea --> Draft'),
  )
  await expect(page.getByTestId('diagram').locator('svg')).toHaveCount(2)
})

test('/name in the prompt pill runs a skill; the recording skill names the missing tools', async ({
  page,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, '/terminal-recording show npm test running')
  await tray(page).getByRole('button').first().click()
  // scripts/e2e-server.ts makes every `requires:` tool count as missing, on any machine: the job
  // says so at once.
  await expect(tray(page)).toContainText('failed · missing tool')
  await expect(tray(page)).toContainText('Missing on PATH: asciinema, agg')
})

test('the video skill is a stub and says so', async ({ page }) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, '/video a ten second intro')
  await tray(page).getByRole('button').first().click()
  await expect(tray(page)).toContainText('stub')
})

test('a skill saved in .zen/skills appears while the editor is open and runs; a broken one says why', async ({
  page,
  app,
}) => {
  await openArticle(page)
  // Written after the page loaded: the server's watcher tells the client, no reload needed.
  const dir = path.join(app.workspace, '.zen', 'skills')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'haiku.md'),
    '---\nname: haiku\ndescription: Rewrite as a haiku\n---\nRewrite the target as a haiku: five, seven, five.\n',
  )
  writeFileSync(path.join(dir, 'broken.md'), '---\nname: broken\n---\nno description\n')

  // The broken file is visible to the writer, not only in a console: a notice, then a list in
  // the agent panel that stays until the file is fixed.
  await expect(notice(page)).toContainText('Skill not loaded: .zen/skills/broken.md')
  await expect(notice(page)).toContainText('description:')
  await page.keyboard.press(`${mod}+Alt+b`)
  const problems = page.getByRole('list', { name: 'Skills not loaded' })
  await expect(problems).toContainText('.zen/skills/broken.md')
  await expect(page.getByRole('button', { name: '/haiku' })).toBeVisible()

  // The valid one is an ordinary skill: the palette runs it and its body reaches the agent.
  await runCommand(page, 'run skill haiku')
  await answer(page, 'Instruction for the haiku skill', 'the closing paragraph')
  const jobId = await expectOneWaiting(app)
  const instruction = readFileSync(jobFile(app, jobId, 'instruction.md'), 'utf8')
  expect(instruction).toContain('## Skill: haiku')
  expect(instruction).toContain('five, seven, five')

  writeFileSync(
    path.join(dir, 'broken.md'),
    '---\nname: broken\ndescription: Fixed now\n---\nA prompt.\n',
  )
  await expect(problems).toHaveCount(0)
  await expect(page.getByRole('button', { name: '/broken' })).toBeVisible()
})
