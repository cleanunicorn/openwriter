import { z } from 'zod'
import { DocRefSchema } from './api-types.ts'
import { JobSchema } from './jobs/job-types.ts'

/** Server → client events on `/api/events` (SSE). The client zod-parses every message. */
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('doc.changed'), ref: DocRefSchema, hash: z.string().nullable() }),
  z.object({ type: z.literal('config.changed') }),
  z.object({ type: z.literal('job.state'), job: JobSchema }),
  z.object({ type: z.literal('job.progress'), id: z.string(), text: z.string() }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
