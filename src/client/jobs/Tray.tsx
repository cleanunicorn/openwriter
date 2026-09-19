import { useState } from 'react'
import { docKey } from '../../shared/api-types.ts'
import { parseHerdrAttachHint } from '../../shared/jobs/herdr-hint.ts'
import { isActive, type Job } from '../../shared/jobs/job-types.ts'
import { openDoc } from '../state/app.ts'
import {
  cancelJob,
  dismissJob,
  dropHeld,
  setResearchJob,
  setTrayOpen,
  useJobs,
} from '../state/jobs.ts'

const LABELS: Record<Job['state'], string> = {
  queued: 'waiting for a free slot',
  running: 'running',
  validating: 'checking the result',
  repairing: 'repairing the result',
  ready: 'ready for review',
  settled: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  stale: 'stale',
}

const REASONS: Record<NonNullable<Job['reason']>, string> = {
  'missing-cli': 'agent not found',
  'missing-tool': 'missing tool',
  auth: 'not signed in',
  timeout: 'timed out',
  'invalid-result': 'invalid result',
  exit: 'agent error',
}

/** "Open this job in herdr": the server cannot attach a terminal for the writer, so show how. */
function OpenInHerdr({ progress }: { progress: string[] }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const command = progress.map(parseHerdrAttachHint).find((hint) => hint !== null)
  if (command === undefined || command === null) return null
  // The clipboard can be missing (an insecure context) or refuse: say which happened.
  const copy = () =>
    void (navigator.clipboard?.writeText(command) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setCopied('yes'))
      .catch(() => setCopied('no'))
  return (
    <div className="tray-progress">
      Open this job in herdr: <code>{command}</code>{' '}
      <button type="button" className="link" onClick={copy}>
        Copy
      </button>{' '}
      <span role="status" aria-label="Copy result">
        {copied === 'yes' && 'Copied.'}
        {copied === 'no' && 'Could not copy — select the command instead.'}
      </span>
    </div>
  )
}

function JobRow({ job }: { job: Job }) {
  const active = isActive(job.state)
  const last = job.progress[job.progress.length - 1]
  return (
    <li className="tray-job" data-state={job.state}>
      <div className="tray-line">
        <span className="tray-instruction">{job.instruction}</span>
        <span className="tray-state">
          {LABELS[job.state]}
          {job.reason !== null && ` · ${REASONS[job.reason]}`}
        </span>
      </div>
      {active && last !== undefined && <div className="tray-progress">{last}</div>}
      {job.state === 'ready' && job.result !== null && (
        <div className="tray-progress">{job.result.summary}</div>
      )}
      {active && job.adapter === 'herdr' && <OpenInHerdr progress={job.progress} />}
      {job.error !== null && <div className="tray-error">{job.error}</div>}
      {(job.rawOutput !== null || (job.state === 'stale' && job.result !== null)) && (
        <details className="tray-output">
          <summary>Show the agent’s output</summary>
          <pre>{job.rawOutput ?? JSON.stringify(job.result, null, 2)}</pre>
        </details>
      )}
      <div className="tray-actions">
        {active && (
          <button type="button" className="link" onClick={() => void cancelJob(job.id)}>
            Cancel
          </button>
        )}
        {job.state === 'ready' && job.scope === 'research' && (
          <button type="button" className="link" onClick={() => setResearchJob(job.id)}>
            Open notes
          </button>
        )}
        {job.state === 'ready' && job.scope !== 'research' && (
          <button type="button" className="link" onClick={() => void openDoc(job.doc)}>
            Review in {docKey(job.doc)}
          </button>
        )}
        {!active && (
          <button type="button" className="link" onClick={() => void dismissJob(job.id)}>
            {job.state === 'ready' ? 'Reject and dismiss' : 'Dismiss'}
          </button>
        )}
      </div>
    </li>
  )
}

/** Unobtrusive: exists only while there is a job, and shows a count until it is opened. */
export function Tray() {
  const jobs = useJobs((state) => state.jobs)
  const order = useJobs((state) => state.order)
  const held = useJobs((state) => state.held)
  const open = useJobs((state) => state.trayOpen)
  const list = order.flatMap((id) => (jobs[id] === undefined ? [] : [jobs[id]]))
  if (list.length === 0 && held.length === 0) return null

  const running = list.filter((job) => isActive(job.state)).length + held.length
  const review = list.filter((job) => job.state === 'ready').length
  const failed = list.filter((job) => job.state === 'failed' || job.state === 'stale').length
  const label =
    [
      running > 0 && `${running} running`,
      review > 0 && `${review} to review`,
      failed > 0 && `${failed} need a look`,
    ]
      .filter(Boolean)
      .join(' · ') || `${list.length} done`

  return (
    <section className="tray" aria-label="Agent jobs">
      <button
        type="button"
        className="tray-toggle"
        aria-expanded={open}
        onClick={() => setTrayOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <ul className="tray-list">
          {held.map((request) => (
            <li key={request.id} className="tray-job" data-state="held">
              <div className="tray-line">
                <span className="tray-instruction">{request.request.instruction}</span>
                <span className="tray-state">queued behind another job</span>
              </div>
              <div className="tray-actions">
                <button type="button" className="link" onClick={() => dropHeld(request.id)}>
                  Cancel
                </button>
              </div>
            </li>
          ))}
          {[...list].reverse().map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}
    </section>
  )
}
