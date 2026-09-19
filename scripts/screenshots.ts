// Light and dark screenshots for the PR: the editor at rest, and a review in progress.
// Usage: node scripts/screenshots.ts   (starts its own server on a temp copy of the sample)
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'docs', 'screenshots')
mkdirSync(out, { recursive: true })

function startServer(): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'e2e-server.ts'), '--fake-control'],
      { cwd: root },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const url = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (url !== undefined) resolve({ url, child })
    })
    child.once('exit', () => reject(new Error(output)))
  })
}

const { url, child } = await startServer()
const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 860 },
      colorScheme: theme,
    })
    await page.goto(url)
    await page.locator('.mermaid-block svg').waitFor()
    await page.screenshot({ path: path.join(out, `editor-${theme}.png`) })

    // A job on the heading, reviewed as a ghost diff, with the tray open.
    await page.getByRole('heading', { name: 'Why blocks' }).dblclick()
    await page
      .getByRole('textbox', { name: 'Instruction for the agent' })
      .fill('fake:multi tighten this section')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      async () =>
        ((await (await fetch('/api/__fake/waiting')).json()) as { waiting: string[] }).waiting
          .length > 0,
    )
    await page.evaluate(() =>
      fetch('/api/__fake/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    await page.getByTestId('ghost').first().waitFor()
    await page.getByRole('region', { name: 'Agent jobs' }).getByRole('button').first().click()
    await page.screenshot({ path: path.join(out, `review-${theme}.png`) })
    await page.getByTestId('ghost').first().getByRole('button', { name: 'Reject all' }).click()
    await page.close()
  }
} finally {
  await browser.close()
  child.kill('SIGTERM')
}
console.log(`wrote 4 screenshots to ${path.relative(root, out)}`)
