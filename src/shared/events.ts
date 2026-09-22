import { z } from 'zod'
import { DocRefSchema } from './api-types.ts'
import { JobSchema } from './jobs/job-types.ts'

/** Server → client events on `/api/events` (SSE). The client zod-parses every message. */
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('doc.changed'), ref: DocRefSchema, hash: z.string().nullable() }),
  z.object({ type: z.literal('config.changed') }),
  /** A file in `<workspace>/.zen/skills/` changed what the palette lists; refetch `/api/skills`. */
  z.object({ type: z.literal('skills.changed') }),
  /** The server moved to another workspace; every tab but the one that asked has to follow. */
  z.object({ type: z.literal('workspace.changed'), root: z.string(), label: z.string() }),
  z.object({ type: z.literal('job.state'), job: JobSchema }),
  z.object({ type: z.literal('job.progress'), id: z.string(), text: z.string() }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
