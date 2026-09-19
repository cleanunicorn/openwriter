import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures.ts'
import {
  ask,
  blockWith,
  expectFile,
  expectWaiting,
  ghosts,
  jobFile,
  mod,
  openArticle,
  release,
  selectWord,
  tray,
} from './helpers.ts'

test('a skill from the palette runs as an ordinary job; the diagram renders in the ghost and after accept', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill('run skill diagram')
  await page.keyboard.press('Enter')
  await page
    .getByRole('combobox', { name: 'Instruction for the diagram skill' })
    .fill('fake:diagram from idea to post')
  await page.keyboard.press('Enter')

  const [jobId] = await expectWaiting(app, 1)
  const instruction = readFileSync(jobFile(app, jobId, 'instruction.md'), 'utf8')
  expect(instruction).toContain('## Skill: diagram')
  await release(app)

  // The editor has no diagram feature: the job returned a block, and blocks with mermaid render.
  await expect(ghosts(page).getByTestId('diagram').locator('svg')).toContainText('Draft')
  await ghosts(page).getByRole('button', { name: 'Accept', exact: true }).click()
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
  // asciinema and agg are not installed on the test machine or in CI: the job says so at once.
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
