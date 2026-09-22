import type { ClearJobsResponse } from '../../shared/jobs/job-types.ts'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** What a clear did, in one line: what went, what stayed and why, and what was refused. */
export function describeClear({ removed, kept, skipped }: ClearJobsResponse): string {
  const parts = [
    removed.length === 0
      ? 'No finished jobs to clear.'
      : `Cleared ${plural(removed.length, 'finished job', 'finished jobs')}.`,
  ]
  if (kept > 0)
    parts.push(
      `Kept ${plural(kept, 'job that is', 'jobs that are')} still queued, running or awaiting review.`,
    )
  const first = skipped[0]
  if (first !== undefined) {
    parts.push(
      `Left ${plural(skipped.length, 'job directory', 'job directories')} alone (${first.id}: ${first.reason}).`,
    )
  }
  return parts.join(' ')
}
