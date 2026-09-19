import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { PathEscapeError } from './paths.ts'
import { localOnly } from './security.ts'

export type AppOptions = {
  /** Absolute path of the workspace the server owns. */
  workspace: string
  /** Built client (dist/client). Absent in the dev flow, where Vite serves the client. */
  clientDir?: string
  /** Adapter forced from the command line (`--adapter fake`); never persisted. */
  adapterOverride?: string
  /** Mounts the test-only fake control route. */
  fakeControl: boolean
  allowedHosts: () => string[]
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono()
  app.use('*', localOnly(options.allowedHosts))

  app.onError((error, c) => {
    if (error instanceof PathEscapeError) return c.json({ error: error.message }, 400)
    console.error(error)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/api/health', (c) => c.json({ ok: true, workspace: path.basename(options.workspace) }))

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  const clientDir = options.clientDir
  if (clientDir !== undefined && existsSync(clientDir)) {
    const root = path.relative(process.cwd(), clientDir) || '.'
    app.use('/*', serveStatic({ root }))
    // Single-page app: every other GET gets the shell.
    app.get('*', (c) => c.html(readFileSync(path.join(clientDir, 'index.html'), 'utf8')))
  }
  return app
}
