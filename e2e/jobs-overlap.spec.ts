import { expect, test } from './fixtures.ts'
import {
  acceptButton,
  ask,
  blockEnd,
  blockWith,
  editor,
  expectFile,
  expectWaiting,
  ghosts,
  openArticle,
  release,
  selectWord,
  tray,
} from './helpers.ts'

test('two sections get different instructions while the writer types in a third; both arrive as ghost diffs', async ({
  page,
  app,
}) => {
  await openArticle(page)

  // Job one on a heading, job two on a paragraph far away. Neither waits for the other.
  await selectWord(page, blockWith(page, 'Why blocks'), 'Why blocks')
  await ask(page, 'fake:upper shout this heading')
  await selectWord(page, blockWith(page, 'Results arrive as ghost diffs'), 'Results')
  await ask(page, 'fake:insert add a sentence after this')
  await expectWaiting(app, 2)
  await expect(tray(page).getByRole('button', { name: '2 running' })).toBeVisible()
  await expect(blockWith(page, 'Why blocks')).toHaveClass(/is-pending/)
  await expect(blockWith(page, 'Results arrive as ghost diffs')).toHaveClass(/is-pending/)

  // Meanwhile the writer keeps typing in a third block. Nothing is frozen.
  await page.getByText('This is a sample article.').click()
  await page.keyboard.press(blockEnd)
  await page.keyboard.type(' Still typing while two agents work.')
  await expect(editor(page)).toContainText('Still typing while two agents work.')

  // Both results arrive while the editor is still open.
  await release(app)
  await expect(ghosts(page)).toHaveCount(2)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type(' And still typing.')
  await expect(editor(page)).toContainText('And still typing.')

  // Review both, each job on its own.
  await acceptButton(page.getByRole('group', { name: 'Proposed replacement 1 of 1' })).click()
  await acceptButton(page.getByRole('group', { name: 'Proposed insertion 1 of 1' })).click()
  await expect(ghosts(page)).toHaveCount(0)

  await expectFile(app.articlePath(), (file) => {
    expect(file).toContain('## WHY BLOCKS\n')
    expect(file).toContain('reject the rest.\n\nInserted by the fake agent.\n')
    expect(file).toContain(
      'render it again. Still typing while two agents work. And still typing.\n',
    )
  })
})
