// Light and dark screenshots for the PR, four states each:
//   editor  — both panels closed: the zen page (1180px)
//   review  — a job reviewed as a ghost diff, the agent panel docked beside it (1180px)
//   panels  — both panels docked: files and actions, the agent conversation (1500px)
//   narrow  — a narrow window: the left drawer over the page, the agent panel below the article (900px)
// Usage: node scripts/screenshots.ts   (starts its own server per theme on a temp copy of the sample)
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
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
  }
} finally {
  await browser.close()
}
console.log(`wrote ${written} screenshots to ${path.relative(root, out)}`)
