import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createClaudeAdapter } from './adapters/claude.ts'
import { createCodexAdapter } from './adapters/codex.ts'
import { createFakeAdapter, FakeGate } from './adapters/fake.ts'
import { AdapterRegistry } from './adapters/registry.ts'
import type { AppOptions, ServerContext } from './context.ts'
import { HttpError } from './http.ts'
import { PathEscapeError } from './paths.ts'
import { mountConfigRoutes } from './routes/config.ts'
import { mountDocRoutes } from './routes/docs.ts'
import { mountFakeControl, mountJobRoutes } from './routes/jobs.ts'
import { JobManager } from './jobs/manager.ts'
import { localOnly } from './security.ts'
import { EventHub } from './sse.ts'
import { DocWatcher } from './watcher.ts'
import { ConflictError, UndecodableError, Workspace } from './workspace.ts'

export type { AppOptions } from './context.ts'

export type CreatedApp = {
  app: Hono
  context: ServerContext
  jobs: JobManager
  gate: FakeGate
  dispose: () => void
}

export function createApp(options: AppOptions): CreatedApp {
  const workspace = new Workspace(options.workspace)
  const events = new EventHub()
  const watcher = new DocWatcher(workspace, events)
  const gate = new FakeGate(options.fakeControl)
  const registry = new AdapterRegistry()
    .register(createClaudeAdapter())
    .register(createCodexAdapter())
    .register(createFakeAdapter(gate))
  const context: ServerContext = {
    options,
    workspace,
    events,
    watcher,
    adapterNames: () => registry.names(),
  }
  const jobs = new JobManager({
    workspace,
    events,
    registry,
    adapterOverride: options.adapterOverride,
    toolLookup: options.toolLookup,
    skillsDir: options.skillsDir,
  })

  const app = new Hono()
  app.use('*', localOnly(options.allowedHosts))

  app.onError((error, c) => {
    if (error instanceof PathEscapeError) return c.json({ error: error.message }, 400)
    if (error instanceof HttpError)
      return c.json({ error: error.message, ...error.body }, error.status)
    if (error instanceof ConflictError)
      return c.json({ error: error.message, ...error.current }, 409)
    if (error instanceof UndecodableError) return c.json({ error: error.message }, 422)
    console.error(error)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/api/health', (c) => c.json({ ok: true, workspace: path.basename(options.workspace) }))

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) })
      })
      stream.onAbort(unsubscribe)
      await stream.writeSSE({ event: 'hello', data: '{}' })
      // Keep the connection open; a comment line every 25 s defeats idle timeouts.
      while (!stream.aborted) {
        await stream.sleep(25_000)
        await stream.write(': keep-alive\n\n')
      }
    }),
  )

  mountDocRoutes(app, context)
  mountConfigRoutes(app, context)
  mountJobRoutes(app, context, jobs)
  // Never mounted in normal use: the route exists only with --fake-control.
  if (options.fakeControl) mountFakeControl(app, gate)

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  const clientDir = options.clientDir
  if (clientDir !== undefined && existsSync(clientDir)) {
    const root = path.relative(process.cwd(), clientDir) || '.'
    app.use('/*', serveStatic({ root }))
    // Single-page app: every other GET gets the shell.
    app.get('*', (c) => c.html(readFileSync(path.join(clientDir, 'index.html'), 'utf8')))
  }
  return {
    app,
    context,
    jobs,
    gate,
    dispose: () => {
      watcher.close()
      void jobs.shutdown()
    },
  }
}
