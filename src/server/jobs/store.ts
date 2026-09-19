import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { AdapterConfigSchema } from '../../shared/config-schema.ts'
import { isUnsettled, type Job, JobSchema } from '../../shared/jobs/job-types.ts'

/** `job.json`: server-owned lifecycle metadata next to the contract files. */
export const JobFileSchema = z.object({
  version: z.literal(1),
  job: JobSchema,
  /** The adapter settings this job was launched with; later settings changes do not affect it. */
  effectiveConfig: z.object({ adapter: AdapterConfigSchema, timeoutSec: z.number() }),
  /** `assets/<file>` → name in the bundle, for assets already copied by an earlier accept. */
  promoted: z.record(z.string(), z.string()).default({}),
  dismissed: z.boolean().default(false),
})
export type JobFile = z.infer<typeof JobFileSchema>

export function saveJobFile(jobDir: string, file: JobFile): void {
  mkdirSync(jobDir, { recursive: true })
  const target = path.join(jobDir, 'job.json')
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`)
  renameSync(temp, target)
}

export function readJobFile(jobDir: string): JobFile | undefined {
  try {
    const parsed = JobFileSchema.safeParse(
      JSON.parse(readFileSync(path.join(jobDir, 'job.json'), 'utf8')),
    )
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * On server start, block IDs from the previous session are no longer authoritative: every job
 * that was queued, running, or waiting for review becomes `stale`. Its output stays readable in
 * the tray (nothing is lost); it is never resumed or re-applied by matching positions.
 */
export function recoverJobs(jobsDir: string): JobFile[] {
  if (!existsSync(jobsDir)) return []
  const recovered: JobFile[] = []
  for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const jobDir = path.join(jobsDir, entry.name)
    const file = readJobFile(jobDir)
    if (file === undefined || file.dismissed) continue
    const job: Job = file.job
    if (isUnsettled(job.state)) {
      let rawOutput = job.rawOutput
      const resultPath = path.join(jobDir, 'result.json')
      if (rawOutput === null && existsSync(resultPath)) rawOutput = readFileSync(resultPath, 'utf8')
      file.job = {
        ...job,
        state: 'stale',
        error:
          'The app restarted before this job was reviewed. Its output is kept here; start a new job to apply it.',
        rawOutput,
        updatedAt: new Date().toISOString(),
      }
      saveJobFile(jobDir, file)
    }
    if (file.job.state === 'stale') recovered.push(file)
  }
  return recovered
}
