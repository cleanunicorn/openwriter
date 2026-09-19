import type { Hono } from 'hono'
import { ConfigSchema } from '../../shared/config-schema.ts'
import { saveConfig } from '../config.ts'
import type { ServerContext } from '../context.ts'
import { HttpError, parseBody } from '../http.ts'

export function mountConfigRoutes(app: Hono, context: ServerContext): void {
  const { workspace, events, options } = context
  const response = () => {
    const { config, error } = workspace.config()
    return {
      config,
      error,
      contentOutsideWorkspace: workspace.contentOutsideWorkspace(),
      adapters: context.adapterNames(),
      adapterOverride: options.adapterOverride ?? null,
    }
  }

  app.get('/api/config', (c) => c.json(response()))

  app.put('/api/config', async (c) => {
    const config = await parseBody(c, ConfigSchema)
    try {
      saveConfig(workspace.root, config)
    } catch (error) {
      throw new HttpError(409, (error as Error).message)
    }
    events.emit({ type: 'config.changed' })
    return c.json(response())
  })
}
