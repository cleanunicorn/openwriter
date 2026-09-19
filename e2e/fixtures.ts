import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'
import { startE2eServer } from './start-server.ts'

export type App = {
  url: string
  /** Absolute path of this test's own copy of the sample workspace. */
  workspace: string
  articlePath: (slug?: string) => string
  readArticle: (slug?: string) => string
}

/** Every test that uses `app` gets its own server process and its own workspace copy. */
export const test = base.extend<{ app: App }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern here
  app: async ({}, use) => {
    const { url, workspace, child } = await startE2eServer()
    const articlePath = (slug = 'hello-openwrite') =>
      path.join(workspace, 'content', 'posts', slug, 'index.md')
    await use({
      url,
      workspace,
      articlePath,
      readArticle: (slug) => readFileSync(articlePath(slug), 'utf8'),
    })
    child.removeAllListeners('exit')
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  },
  baseURL: async ({ app }, use) => {
    await use(app.url)
  },
})

export { expect }
