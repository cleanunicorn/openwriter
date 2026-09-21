import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type CreatedApp, createApp } from './app.ts'
import type { AppOptions } from './context.ts'

/** The Host every test request carries; the test app allows exactly this one. */
export const HOST = '127.0.0.1:4317'

export type TestApp = CreatedApp & {
  workspace: string
  /** This test's own known-workspace list; never the developer's `~/.config`. */
  workspacesFile: string
  get: (url: string) => Promise<Response>
  send: (method: string, url: string, body?: unknown) => Promise<Response>
  cleanup: () => void
}

/** A fresh temp copy of the sample workspace plus an in-process app bound to it. */
export function createTestApp(overrides: Partial<AppOptions> = {}): TestApp {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'openwrite-test-'))
  cpSync(path.resolve(import.meta.dirname, '..', '..', 'sample-workspace'), workspace, {
    recursive: true,
  })
  // Beside the workspace, not inside it: a test may erase the workspace, and the list has to
  // outlive that. Defaulted here so no existing caller has to know about it.
  const state = mkdtempSync(path.join(os.tmpdir(), 'openwrite-test-state-'))
  const workspacesFile = path.join(state, 'workspaces.json')
  const created = createApp({
    workspace,
    workspacesFile,
    fakeControl: false,
    adapterOverride: 'fake',
    allowedHosts: () => [HOST],
    ...overrides,
  })
  return {
    ...created,
    workspace,
    workspacesFile,
    get: async (url) => created.app.request(url, { headers: { host: HOST } }),
    send: async (method, url, body = {}) =>
      created.app.request(url, {
        method,
        headers: { host: HOST, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    cleanup: () => {
      void created.dispose()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(state, { recursive: true, force: true })
    },
  }
}

/** Test bodies are asserted field by field, not typed. */
// biome-ignore lint/suspicious/noExplicitAny: loose JSON for assertions only
export async function json(response: Response | Promise<Response>): Promise<any> {
  return (await response).json()
}
