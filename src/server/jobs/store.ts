import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { AdapterConfigSchema } from '../../shared/config-schema.ts'
import { isUnsettled, type Job, JobSchema } from '../../shared/jobs/job-types.ts'
import { readJobText, readJobTextOrNull, writeJobText } from './job-io.ts'

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
  writeJobText(jobDir, 'job.json', `${JSON.stringify(file, null, 2)}\n`)
}

/** job.json sits in a directory the agent may write, so it is read without following links and re-validated. */
export function readJobFile(jobDir: string): JobFile | undefined {
  try {
    const text = readJobText(jobDir, 'job.json')
    if (text === null) return undefined
    const parsed = JobFileSchema.safeParse(JSON.parse(text))
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
    try {
      recoverOne(jobDir, file, recovered)
    } catch (error) {
      // One unreadable job directory must not stop the server from starting.
      console.error(`could not recover job ${entry.name}`, error)
    }
  }
  return recovered
}

function recoverOne(jobDir: string, file: JobFile, recovered: JobFile[]): void {
  const job: Job = file.job
  if (isUnsettled(job.state)) {
    file.job = {
      ...job,
      state: 'stale',
      error:
        'The app restarted before this job was reviewed. Its output is kept here; start a new job to apply it.',
      rawOutput: job.rawOutput ?? readJobTextOrNull(jobDir, 'result.json'),
      updatedAt: new Date().toISOString(),
    }
    saveJobFile(jobDir, file)
  }
  if (file.job.state === 'stale') recovered.push(file)
}
