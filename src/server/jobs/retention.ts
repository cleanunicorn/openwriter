import { existsSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { isFinished } from '../../shared/jobs/job-types.ts'
import { isJobId, removeJobDir } from './job-io.ts'
import { type JobFile, readJobFile } from './store.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether a job on disk is old enough to be pruned when its workspace opens. Only work that is
 * over and that the writer no longer sees: done, failed and cancelled jobs (a restart does not
 * bring them back to the agent panel), and any finished job the writer dismissed. A stale job
 * that was not dismissed is on screen with its output "so nothing is lost", so only the writer
 * clears it. Nothing queued, running or awaiting review is ever old enough.
 */
export function isExpired(file: JobFile, now: number, retentionDays: number): boolean {
  if (retentionDays <= 0) return false
  const { state, updatedAt } = file.job
  if (!isFinished(state)) return false
  if (state === 'stale' && !file.dismissed) return false
  const updated = Date.parse(updatedAt)
  // An unreadable timestamp is not evidence of age.
  if (Number.isNaN(updated)) return false
  return now - updated > retentionDays * DAY_MS
}

/** The names under `.zen/jobs` that are job ids; anything else there is not ours to touch. */
export function jobIdsIn(jobsDir: string): string[] {
  if (!existsSync(jobsDir) || !lstatSync(jobsDir).isDirectory()) return []
  return readdirSync(jobsDir).filter(isJobId).sort()
}

/** `<jobsDir>/<id>` is a directory itself, not a symlink to one (lstat, never stat). */
export function isPlainDirectory(jobsDir: string, id: string): boolean {
  try {
    return lstatSync(path.join(jobsDir, id)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Delete the job directories of `jobsDir` that `isExpired` allows. Runs before restart recovery,
 * when no agent of this workspace is running. Returns the ids it removed; one directory that
 * cannot be read or removed is logged and skipped, never a reason to stop the server starting.
 */
export function pruneExpiredJobs(
  jobsDir: string,
  retentionDays: number,
  now = Date.now(),
): string[] {
  if (retentionDays <= 0) return []
  const removed: string[] = []
  for (const id of jobIdsIn(jobsDir)) {
    // A symlink is never read through, let alone deleted; removeJobDir would refuse it anyway.
    if (!isPlainDirectory(jobsDir, id)) continue
    const file = readJobFile(path.join(jobsDir, id))
    // job.json is agent-writable: its id must name the directory it sits in.
    if (file === undefined || file.job.id !== id || !isExpired(file, now, retentionDays)) continue
    try {
      removeJobDir(jobsDir, id)
      removed.push(id)
    } catch (error) {
      console.error(`could not prune job ${id}`, error)
    }
  }
  return removed
}
