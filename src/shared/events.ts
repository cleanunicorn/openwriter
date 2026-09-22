import { z } from 'zod'
import { DocRefSchema, TabIdSchema } from './api-types.ts'
import { JobSchema } from './jobs/job-types.ts'

/** Server → client events on `/api/events` (SSE). The client zod-parses every message. */
export const ServerEventSchema = z.discriminatedUnion('type', [
  /**
   * A document changed on disk: by another program (the watcher), or by a save through this
   * server, which names the tab that made it (`origin`). That tab ignores its own; every other
   * tab reloads through the three-way merge (#29).
   */
  z.object({
    type: z.literal('doc.changed'),
    ref: DocRefSchema,
    hash: z.string().nullable(),
    origin: TabIdSchema.optional(),
  }),
  z.object({ type: z.literal('config.changed') }),
  /** A file in `<workspace>/.zen/skills/` changed what the palette lists; refetch `/api/skills`. */
  z.object({ type: z.literal('skills.changed') }),
  /** The server moved to another workspace; every tab but the one that asked has to follow. */
  z.object({ type: z.literal('workspace.changed'), root: z.string(), label: z.string() }),
  z.object({ type: z.literal('job.state'), job: JobSchema }),
  z.object({ type: z.literal('job.progress'), id: z.string(), text: z.string() }),
  /** These jobs' directories were cleared; every tab forgets them. */
  z.object({ type: z.literal('job.removed'), ids: z.array(z.string()) }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>

/**
 * The first message on every event stream (SSE event name `hello`): the workspace the server is
 * on as the stream opens. Every event after it is about that workspace until a
 * `workspace.changed` names another — the one ordering the client can rely on, because an HTTP
 * response and an event travel on different connections and may arrive in either order.
 */
export const HelloEventSchema = z.object({ root: z.string() })
export type HelloEvent = z.infer<typeof HelloEventSchema>
