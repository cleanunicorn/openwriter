import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures.ts'
import {
  ask,
  blockWith,
  editor,
  expectFile,
  expectWaiting,
  ghosts,
  mod,
  openArticle,
  pill,
  release,
  selectWord,
  tray,
} from './helpers.ts'

test('select → prompt → review → accept, then one undo step reverts it', async ({ page, app }) => {
  await openArticle(page)
  const heading = blockWith(page, 'Why blocks')
  await selectWord(page, heading, 'Why blocks')
  await ask(page, 'fake:upper make it louder')

  // The target shows a quiet pending mark and the tray appears with a count.
  await expect(heading).toHaveClass(/is-pending/)
  await expect(tray(page).getByRole('button', { name: '1 running' })).toBeVisible()
  await tray(page).getByRole('button', { name: '1 running' }).click()
  await expect(tray(page)).toContainText('fake:upper make it louder')
  await expect(tray(page)).toContainText('read 18 blocks, 1 targets')

  await expectWaiting(app, 1)
  await release(app)

  // A ghost diff in place: nothing has entered the article yet.
  const ghost = ghosts(page)
  await expect(ghost).toHaveCount(1)
  await expect(ghost).toHaveAccessibleName('Proposed replacement 1 of 1')
  await expect(ghost.locator('del').first()).toHaveText('Why')
  await expect(ghost.locator('ins').first()).toHaveText('WHY')
  await expect(ghost.locator('ins').last()).toHaveText('BLOCKS')
  await expect(tray(page)).toContainText('ready for review')
  expect(readFileSync(app.articlePath(), 'utf8')).toContain('## Why blocks\n')

  await ghost.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(ghosts(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'WHY BLOCKS' })).toBeVisible()
  await expectFile(app.articlePath(), (file) => expect(file).toContain('## WHY BLOCKS\n'))

  // Undoing an accepted result is an ordinary edit: one step, and the job does not come back.
  await page.getByRole('main').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press(`${mod}+z`)
  await expect(page.getByRole('heading', { name: 'Why blocks', exact: true })).toBeVisible()
  await expect(ghosts(page)).toHaveCount(0)
})

test('rejecting leaves the article untouched', async ({ page, app }) => {
  await openArticle(page)
  const before = readFileSync(app.articlePath(), 'utf8')
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper')
  await expectWaiting(app, 1)
  await release(app)
  await ghosts(page).getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(ghosts(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Why blocks', exact: true })).toBeVisible()
  await expect(tray(page).getByRole('button', { name: '1 done' })).toBeVisible()
  expect(readFileSync(app.articlePath(), 'utf8')).toBe(before)
})

test('several blocks selected by shift-click; ops reviewed one by one, by mouse and keyboard', async ({
  page,
  app,
}) => {
  await openArticle(page)
  const first = blockWith(page, 'Select some text, type an instruction')
  const second = blockWith(page, 'Results arrive as ghost diffs')
  // A margin click selects a block; shift-click extends the selection.
  await first.getByTestId('gutter').click({ position: { x: 5, y: 5 } })
  await second.locator('.rendered').click({ modifiers: ['Shift'] })
  await expect(first).toHaveClass(/is-selected/)
  await expect(second).toHaveClass(/is-selected/)
  await ask(page, 'fake:multi')
  await expectWaiting(app, 1)
  await release(app)

  // replace + two inserts + delete: inline diff, ghost blocks, struck-through deletion.
  await expect(ghosts(page)).toHaveCount(4)
  await expect(
    page.getByRole('group', { name: 'Proposed replacement 1 of 4' }).locator('ins'),
  ).toContainText('(tightened)')
  await expect(page.getByRole('group', { name: 'Proposed insertion 2 of 4' })).toContainText(
    'First insert.',
  )
  await expect(
    page.getByRole('group', { name: 'Proposed deletion 4 of 4' }).locator('.ghost-struck'),
  ).toContainText('Results arrive')

  // Keyboard: Enter accepts the focused proposal, Backspace rejects it.
  await page.getByRole('group', { name: 'Proposed replacement 1 of 4' }).focus()
  await page.keyboard.press('Enter')
  await expect(ghosts(page)).toHaveCount(3)
  await page.getByRole('group', { name: 'Proposed insertion 2 of 4' }).focus()
  await page.keyboard.press('Backspace')
  await expect(ghosts(page)).toHaveCount(2)
  // Mouse for the rest.
  await page
    .getByRole('group', { name: 'Proposed insertion 3 of 4' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click()
  await page
    .getByRole('group', { name: 'Proposed deletion 4 of 4' })
    .getByRole('button', { name: 'Accept', exact: true })
    .click()
  await expect(ghosts(page)).toHaveCount(0)

  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain(
      'while the agent works. (tightened)\n\nSecond insert.\n\nWith a second block.\n',
    )
    expect(file).not.toContain('First insert.')
    expect(file).not.toContain('Results arrive as ghost diffs')
  })
})

test('accept all and reject all work from the keyboard', async ({ page, app }) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Results arrive as ghost diffs'), 'Results')
  await ask(page, 'fake:multi')
  await expectWaiting(app, 1)
  await release(app)
  await expect(ghosts(page)).toHaveCount(3)
  await ghosts(page).first().focus()
  await page.keyboard.press(`${mod}+Enter`)
  await expect(ghosts(page)).toHaveCount(0)
  await expectFile(app.articlePath(), (file) =>
    expect(file).toContain(
      'reject the rest. (tightened)\n\nFirst insert.\n\nSecond insert.\n\nWith a second block.\n',
    ),
  )
})

test('on accept, assets move into the bundle and references are rewritten', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await selectWord(page, blockWith(page, 'Results arrive as ghost diffs'), 'Results')
  await ask(page, 'fake:asset')
  await expectWaiting(app, 1)
  await release(app)

  const bundle = path.dirname(app.articlePath())
  // The preview loads the image from the job directory; the bundle is untouched until accept.
  await expect(
    ghosts(page).locator('img[src*="/api/jobs/"][src$="/assets/fake-diagram.png"]'),
  ).toBeVisible()
  expect(existsSync(path.join(bundle, 'fake-diagram.png'))).toBe(false)

  await ghosts(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.locator('img[src$="/hello-openwrite/assets/fake-diagram.png"]')).toBeVisible()
  expect(readdirSync(bundle)).toContain('fake-diagram.png')
  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('![Fake diagram](fake-diagram.png)')
    expect(file).not.toContain('assets/fake-diagram.png')
  })
})

test('a selection made in edit mode carries exact offsets, and the draft survives the pill', async ({
  page,
  app,
}) => {
  await openArticle(page)
  await page.getByRole('heading', { name: 'Why blocks' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' now')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
  await expect(pill(page)).toBeVisible()
  await ask(page, 'fake:upper')

  // Focus moved to the pill: the edit was committed, not dropped.
  await expect(page.getByRole('heading', { name: 'Why blocks now' })).toBeVisible()
  const [jobId] = await expectWaiting(app, 1)
  const targets = JSON.parse(
    readFileSync(path.join(app.workspace, '.zen', 'jobs', jobId ?? '', 'targets.json'), 'utf8'),
  )
  expect(targets.selection).toMatchObject({ text: 'now', from: 14, to: 17 })
  // The snapshot holds the text as typed, focused editor included.
  expect(
    readFileSync(path.join(app.workspace, '.zen', 'jobs', jobId ?? '', 'article.md'), 'utf8'),
  ).toContain('## Why blocks now')
  await release(app)
  await expect(ghosts(page)).toHaveCount(1)
  await expect(editor(page)).toHaveCount(0)
})
