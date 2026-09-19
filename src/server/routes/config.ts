import type { Hono } from 'hono'
import { ConfigSchema } from '../../shared/config-schema.ts'
import { InvalidConfigError, saveConfig } from '../config.ts'
import type { ServerContext } from '../context.ts'
import { HttpError, parseBody } from '../http.ts'
import { Workspace } from '../workspace.ts'

export function mountConfigRoutes(app: Hono, context: ServerContext): void {
  const { workspace, events, options } = context
  const response = () => {
    const { config, error } = workspace.config()
    // Never throws: a bad contentDir (hand-edited) must still leave settings reachable to fix it.
    const contentDirError = workspace.contentDirProblem()
    return {
      config,
      error,
      contentDirError,
      contentOutsideWorkspace: contentDirError === null && workspace.contentOutsideWorkspace(),
      adapters: context.adapterNames(),
      adapterOverride: options.adapterOverride ?? null,
    }
  }

  app.get('/api/config', (c) => c.json(response()))

  app.put('/api/config', async (c) => {
    const config = await parseBody(c, ConfigSchema)
    // Validate what the value resolves to BEFORE it is written: a saved bad value would make
    // every later load fail.
    const problem = Workspace.contentDirProblem(workspace.root, config.contentDir)
    if (problem !== null) throw new HttpError(400, problem)
    try {
      saveConfig(workspace.root, config)
    } catch (error) {
      // Only the known refusal is a conflict. A filesystem error carries an absolute path in its
      // message; it goes to app.onError, which logs it and answers "internal error".
      if (error instanceof InvalidConfigError) throw new HttpError(409, error.message)
      throw error
    }
    context.watcher.reset()
    events.emit({ type: 'config.changed' })
    return c.json(response())
  })
}
