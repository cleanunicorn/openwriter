// Light and dark screenshots for the PR, eight states each:
//   editor  — both panels closed: the zen page (1180px)
//   review  — a job reviewed as a ghost diff, the agent panel docked beside it (1180px)
//   panels  — both panels docked: files and actions, the agent conversation (1500px)
//   narrow  — a narrow window: the left drawer over the page, the agent panel below the article (900px)
//   workspace-commands  — the palette's workspace commands, with two workspaces in the list
//   workspace-erase     — the delete-from-disk confirmation, its warning kept while the name is typed
//   workspace-moved     — the "Workspace moved" banner of a tab that held unsaved text
//   workspace-switching — the status line while a switch is under way
// Usage: node scripts/screenshots.ts   (starts its own server per theme on a temp copy of the sample)
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { type Browser, chromium, type Page } from '@playwright/test'
import { startE2eServer } from '../e2e/start-server.ts'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'docs', 'screenshots')
mkdirSync(out, { recursive: true })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Wait until the fake adapter holds a job at its checkpoint. */
const waitForFakeJob = (page: Page) =>
  page.waitForFunction(
    async () =>
      ((await (await fetch('/api/__fake/waiting')).json()) as { waiting: string[] }).waiting
        .length > 0,
  )

/** Let every held fake job finish. */
const releaseFakeJobs = (page: Page) =>
  page.evaluate(() =>
    fetch('/api/__fake/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )

/**
 * The workspace UI, on a server of its own (the first one's panels are open by then). The first
 * workspace is renamed "Blog" so no temp folder name shows; a second one, "notes", joins the list.
 */
async function workspaceShots(
  browser: Browser,
  theme: 'light' | 'dark',
  shot: (page: Page, name: string) => Promise<void>,
): Promise<void> {
  const { url, workspace, child } = await startE2eServer()
  try {
    const context = await browser.newContext({
      viewport: { width: 1180, height: 860 },
      colorScheme: theme,
    })
    const page = await context.newPage()
    const palette = async (query: string) => {
      await page.keyboard.press(`${mod}+k`)
      await page.getByRole('combobox', { name: 'Command palette' }).fill(query)
    }
    const run = async (query: string) => {
      await palette(query)
      await page.keyboard.press('Enter')
    }
    const answer = async (label: string, text: string) => {
      await page.getByRole('combobox', { name: label }).fill(text)
      await page.keyboard.press('Enter')
    }
    const article = page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })

    await page.goto(url)
    await page.getByTestId('diagram').locator('svg').waitFor()
    await run(`rename workspace: ${path.basename(workspace)}`)
    await answer(`New name for ${path.basename(workspace)}`, 'Blog')
    await run('new workspace')
    await answer('New workspace name', 'notes')
    await page.getByText('No article yet').waitFor()
    await run('switch to workspace: Blog')
    await article.waitFor()
    await page.getByTestId('diagram').locator('svg').waitFor()

    await palette('workspace')
    await page.getByRole('option', { name: 'Switch to workspace: notes' }).waitFor()
    await shot(page, 'workspace-commands')
    await page.keyboard.press('Escape')

    await run('delete workspace from disk: notes')
    await page.getByRole('combobox', { name: 'Delete notes from disk' }).fill('no')
    await page.getByText('It cannot be undone.').waitFor()
    await shot(page, 'workspace-erase')
    await page.keyboard.press('Escape')

    // A second tab with a sentence it could not save yet (its saves are held), when the first
    // one moves the server to "notes".
    const other = await context.newPage()
    await other.goto(url)
    await other.getByTestId('diagram').locator('svg').waitFor()
    let releaseSaves!: () => void
    const saves = new Promise<void>((resolve) => {
      releaseSaves = resolve
    })
    await other.route('**/api/docs/article/**', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      await saves
      await route.continue()
    })
    const held = other.waitForRequest((request) => request.method() === 'PUT')
    await other
      .getByTestId('block')
      .filter({ hasText: 'Why blocks' })
      .getByTestId('block-body')
      .click()
    await other.getByRole('textbox', { name: 'Block editor' }).pressSequentially(', and why now')
    await held
    await run('switch to workspace: notes')
    await page.getByText('No article yet').waitFor()
    releaseSaves()
    await other.getByRole('alert', { name: 'Workspace moved' }).waitFor()
    await other.getByRole('textbox', { name: 'Block editor' }).blur()
    await shot(other, 'workspace-moved')
    await other.getByRole('button', { name: /^Discard the changes/ }).click()
    await other.getByText('No article yet').waitFor()
    await other.close()

    // The switch back, held at the server's door so its status line can be seen.
    let releaseSwitch!: () => void
    const switched = new Promise<void>((resolve) => {
      releaseSwitch = resolve
    })
    await page.route('**/api/workspaces/*/open', async (route) => {
      await switched
      await route.continue()
    })
    await run('switch to workspace: Blog')
    await page.getByRole('status', { name: 'Workspace switch' }).waitFor()
    await shot(page, 'workspace-switching')
    releaseSwitch()
    await article.waitFor()
    await context.close()
  } finally {
    child.kill('SIGTERM')
  }
}

const browser = await chromium.launch()
let written = 0
try {
  for (const theme of ['light', 'dark'] as const) {
    // A fresh server per theme: the panels' open/closed state is kept in the workspace.
    const { url, child } = await startE2eServer()
    try {
      const page = await browser.newPage({
        viewport: { width: 1180, height: 860 },
        colorScheme: theme,
      })
      const shot = async (name: string) => {
        // A panel slides in: never capture it halfway.
        await page.evaluate('Promise.all(document.getAnimations().map((a) => a.finished))')
        await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) })
        written += 1
      }
      await page.goto(url)
      await page.getByTestId('diagram').locator('svg').waitFor()
      await shot('editor')

      // A job on the heading, reviewed as a ghost diff, with the agent panel open beside it.
      await page.getByRole('heading', { name: 'Why blocks' }).dblclick()
      await page
        .getByRole('textbox', { name: 'Instruction for the agent' })
        .fill('fake:multi tighten this section')
      await page.keyboard.press('Enter')
      await waitForFakeJob(page)
      await releaseFakeJobs(page)
      await page.getByTestId('ghost').first().waitFor()
      await page.getByRole('region', { name: 'Agent jobs' }).getByRole('button').first().click()
      await page.getByRole('region', { name: 'Agent', exact: true }).waitFor()
      await shot('review')
      await page.getByTestId('ghost').first().getByRole('button', { name: 'Reject all' }).click()

      // Both panels docked on a wide window.
      await page.setViewportSize({ width: 1500, height: 900 })
      await page.keyboard.press(`${mod}+b`)
      await page.getByRole('navigation', { name: 'Files and actions' }).waitFor()
      await page.mouse.move(0, 0)
      await shot('panels')

      // A narrow window: the left panel (opened by hand) is a drawer, the agent panel stacks.
      await page.setViewportSize({ width: 900, height: 860 })
      await page.locator('#left-panel[data-layout="overlay"]').waitFor()
      await shot('narrow')
      await page.close()
    } finally {
      child.kill('SIGTERM')
    }
    await workspaceShots(browser, theme, async (page, name) => {
      await page.evaluate('Promise.all(document.getAnimations().map((a) => a.finished))')
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) })
      written += 1
    })
  }
} finally {
  await browser.close()
}
console.log(`wrote ${written} screenshots to ${path.relative(root, out)}`)
