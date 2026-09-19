import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test as base, expect } from '@playwright/test'

export type App = {
  url: string
  /** Absolute path of this test's own copy of the sample workspace. */
  workspace: string
  articlePath: (slug?: string) => string
  readArticle: (slug?: string) => string
}

const root = path.resolve(import.meta.dirname, '..')

function startApp(): Promise<{ app: App; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'e2e-server.ts'), '--port', '0', '--fake-control'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const url = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      const workspace = output.match(/workspace: (.+)/)?.[1]?.trim()
      if (url === undefined || workspace === undefined) return
      const articlePath = (slug = 'hello-openwrite') =>
        path.join(workspace, 'content', 'posts', slug, 'index.md')
      resolve({
        child,
        app: {
          url,
          workspace,
          articlePath,
          readArticle: (slug) => readFileSync(articlePath(slug), 'utf8'),
        },
      })
    })
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.once('exit', (code) => reject(new Error(`e2e server exited early (${code})\n${output}`)))
  })
}

/** Every test that uses `app` gets its own server process and its own workspace copy. */
export const test = base.extend<{ app: App }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern here
  app: async ({}, use) => {
    const { app, child } = await startApp()
    await use(app)
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
