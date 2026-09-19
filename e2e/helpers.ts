import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { unzipSync } from 'fflate'
import { type App, expect } from './fixtures.ts'

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
/** End of the whole block; plain `End` stops at the end of the wrapped visual line. */
export const blockEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
export const blockStart = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'

export const blocks = (page: Page): Locator => page.getByTestId('block')
export const blockWith = (page: Page, text: string | RegExp): Locator =>
  blocks(page).filter({ hasText: text })
export const editor = (page: Page): Locator => page.getByRole('textbox', { name: 'Block editor' })
/** dnd-kit also renders a `status` live region, so the notice is addressed by name. */
export const notice = (page: Page): Locator => page.getByRole('status', { name: 'Document notice' })

/** Open the app and wait until the sample article is on screen. */
export async function openArticle(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Hello, openwrite', level: 1 })).toBeVisible()
  // The diagram renders asynchronously and shifts everything below it; wait for the layout to settle.
  await expect(page.getByTestId('diagram').locator('svg')).toBeVisible()
}

/** The element's box in page coordinates; an element that is not rendered fails the test. */
export async function boundingBox(locator: Locator) {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('no box')
  return box
}

/** Text of every rendered block, in document order (front matter excluded). */
export async function blockTexts(page: Page): Promise<string[]> {
  const texts = await page
    .locator('[data-testid="block"][data-kind="content"]')
    .getByTestId('block-body')
    .allInnerTexts()
  return texts.map((text) => text.trim().split('\n')[0] ?? '')
}

/**
 * Move a block with dnd-kit's keyboard sensor. Each step waits for the screen-reader
 * announcement of the previous one, so the test never outruns the sensor and never sleeps.
 */
export async function keyboardMove(
  page: Page,
  block: Locator,
  key: 'ArrowUp' | 'ArrowDown',
): Promise<void> {
  const announcements = page.locator('[aria-live="assertive"]')
  await block.hover()
  await block.getByTestId('drag-handle').focus()
  await page.keyboard.press('Space')
  await expect(announcements).toContainText('Draggable item')
  const pickedUp = await announcements.innerText()
  await page.keyboard.press(key)
  await expect(announcements).not.toHaveText(pickedUp)
  await page.keyboard.press('Space')
  await expect(announcements).toContainText('was dropped')
}

/** Autosave is debounced, so file assertions poll instead of sleeping. */
export async function expectFile(path: string, check: (text: string) => void): Promise<void> {
  await expect(() => check(readFileSync(path, 'utf8'))).toPass({ timeout: 5000 })
}

/** Open the command palette and type a query; the caller decides when to press Enter. */
export async function openPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press(`${mod}+k`)
  await page.getByRole('combobox', { name: 'Command palette' }).fill(query)
}

/** Run the palette command that `query` matches first. */
export async function runCommand(page: Page, query: string): Promise<void> {
  await openPalette(page, query)
  await page.keyboard.press('Enter')
}

/** Run an export command and unzip the download: its name, its entries, the temp directory. */
export async function exportVia(page: Page, query: string) {
  await openPalette(page, query)
  const download = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  const file = await download
  const saved = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'openwrite-export-')),
    file.suggestedFilename(),
  )
  await file.saveAs(saved)
  return {
    name: file.suggestedFilename(),
    files: unzipSync(new Uint8Array(readFileSync(saved))),
    dir: path.dirname(saved),
  }
}

// ── jobs ──────────────────────────────────────────────────────────────────────────────────

export const pill = (page: Page): Locator =>
  page.getByRole('textbox', { name: 'Instruction for the agent' })
export const ghosts = (page: Page): Locator => page.getByTestId('ghost')
export const tray = (page: Page): Locator => page.getByRole('region', { name: 'Agent jobs' })

/** Select a word in a rendered block (double-click) and wait for the prompt pill. */
export async function selectWord(page: Page, block: Locator, word: string): Promise<void> {
  await block.getByText(word, { exact: false }).first().dblclick()
  await expect(pill(page)).toBeVisible()
}

/** Type an instruction into the pill and send it; the pill disappears and the writer carries on. */
export async function ask(page: Page, instruction: string): Promise<void> {
  await pill(page).fill(instruction)
  await page.keyboard.press('Enter')
  await expect(pill(page)).toHaveCount(0)
}

async function fakeControl(
  app: App,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<string[]> {
  const response = await fetch(`${app.url}/api/__fake/${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  const json = (await response.json()) as { waiting?: string[]; released?: string[] }
  return json.waiting ?? json.released ?? []
}

/** IDs of the fake jobs that reached their checkpoint. The test decides when they finish. */
export const waitingJobs = (app: App): Promise<string[]> => fakeControl(app, 'GET', 'waiting')

export async function expectWaiting(app: App, count: number): Promise<string[]> {
  let ids: string[] = []
  await expect(async () => {
    ids = await waitingJobs(app)
    expect(ids).toHaveLength(count)
  }).toPass({ timeout: 5000 })
  return ids
}

/** The id of the one fake job that is waiting at its checkpoint. */
export async function expectOneWaiting(app: App): Promise<string> {
  const [id] = await expectWaiting(app, 1)
  if (id === undefined) throw new Error('no waiting job')
  return id
}

export const release = (app: App, jobId?: string): Promise<string[]> =>
  fakeControl(app, 'POST', 'release', jobId === undefined ? {} : { jobId })

/** The server's view of one job's state. */
export async function jobState(app: App, jobId: string): Promise<string> {
  const response = await fetch(`${app.url}/api/jobs/${jobId}`)
  return ((await response.json()) as { state: string }).state
}

/** End every open event stream on the server, as a network drop would. */
export async function dropEventStreams(app: App): Promise<void> {
  await fakeControl(app, 'POST', 'drop-events')
}

/** A file of a job's contract directory (`.zen/jobs/<id>/<name>`), or the directory itself. */
export const jobFile = (app: App, jobId: string, name = ''): string =>
  path.join(app.workspace, '.zen', 'jobs', jobId, name)

export const briefPath = (app: App, slug = 'hello-openwrite'): string =>
  path.join(app.workspace, '.zen', 'articles', slug, 'brief.md')

export const configPath = (app: App): string => path.join(app.workspace, '.zen', 'config.json')

// `exact` is load-bearing: without it "Accept" also matches "Accept all".
export const acceptButton = (scope: Locator | Page): Locator =>
  scope.getByRole('button', { name: 'Accept', exact: true })
export const rejectButton = (scope: Locator | Page): Locator =>
  scope.getByRole('button', { name: 'Reject', exact: true })
