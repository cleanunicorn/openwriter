import type { Hono } from 'hono'
import { WORKSPACE_HEADER } from '../../shared/api-types.ts'
import { ConfigSchema } from '../../shared/config-schema.ts'
import { InvalidConfigError, saveConfig } from '../config.ts'
import type { ServerContext } from '../context.ts'
import { HttpError, parseBody } from '../http.ts'
import { Workspace } from '../workspace.ts'

export function mountConfigRoutes(app: Hono, context: ServerContext): void {
  const { workspace, events, options } = context
  const configBody = () => {
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

  app.get('/api/config', (c) => c.json(configBody()))

  app.put('/api/config', async (c) => {
    const config = await parseBody(c, ConfigSchema)
    // From here to the write there is no await, so no switch can fall in between: a write meant for
    // the workspace that was open before a switch is refused, never saved into the new one.
    const intended = c.req.header(WORKSPACE_HEADER)
    if (intended !== undefined && intended !== workspace.root) {
      throw new HttpError(409, 'The workspace changed before these settings were saved.')
    }
    // Validate what the value resolves to BEFORE it is written: a saved bad value would make
    // every later load fail.
    const problem = Workspace.contentDirProblemFor(workspace.root, config.contentDir)
    if (problem !== null) throw new HttpError(400, problem)
    const contentDirBefore = workspace.config().config.contentDir
    try {
      saveConfig(workspace.root, config)
    } catch (error) {
      // Only the known refusal is a conflict. A filesystem error carries an absolute path in its
      // message; it goes to app.onError, which logs it and answers "internal error".
      if (error instanceof InvalidConfigError) throw new HttpError(409, error.message)
      throw error
    }
    // Only a moved content directory invalidates what the watcher tracks. Resetting on every save
    // would make each panel toggle or theme switch blind the watcher to outside changes until the
    // open document is saved again (issue #14 §4 is the remaining case: a real contentDir change).
    if (config.contentDir !== contentDirBefore) context.watcher.reset()
    events.emit({ type: 'config.changed' })
    return c.json(configBody())
  })
}
