import { useState } from 'react'
import { type DocRef, docKey } from '../../shared/api-types.ts'
import { parseHerdrAttachHint } from '../../shared/jobs/herdr-hint.ts'
import { isActive, type Job } from '../../shared/jobs/job-types.ts'
import { docLabel, reviewLabel } from '../doc-label.ts'
import { openDoc, useApp } from '../state/app.ts'
import {
  type HeldRequest,
  cancelJob,
  dismissJob,
  dropHeld,
  setResearchJob,
  useJobs,
} from '../state/jobs.ts'
import {
  focusWhenMounted,
  layoutOf,
  revealRightIfStacked,
  setRightOpen,
  useShell,
} from '../shell/state.ts'
import { keepFocus } from '../keep-focus.ts'

const SCOPES: Record<Job['scope'], string> = {
  blocks: 'selection',
  article: 'whole article',
  research: 'research',
}

/** A turn's first line: what the writer asked, and at a glance its scope and skill. */
function TurnHeader({
  doc,
  instruction,
  scope,
  skill,
}: {
  doc: DocRef
  instruction: string
  scope: Job['scope']
  skill: string | null | undefined
}) {
  // The transcript holds every document's turns; one about another document says which.
  const other = useApp((state) =>
    state.current !== null && docKey(state.current) === docKey(doc)
      ? null
      : docLabel(doc, state.articles),
  )
  return (
    <div className="tray-line">
      <span className="tray-instruction" title={instruction}>
        {instruction}
      </span>
      <span className="turn-chips">
        {other !== null && <span className="chip">{other}</span>}
        <span className="chip">{SCOPES[scope]}</span>
        {skill != null && <span className="chip">/{skill}</span>}
      </span>
    </div>
  )
}

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
  if (command === undefined) return null
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
  const review = useApp((state) => reviewLabel(job.doc, state.current, state.articles))
  const last = job.progress[job.progress.length - 1]
  return (
    <li className="tray-job" data-state={job.state}>
      <TurnHeader doc={job.doc} instruction={job.instruction} scope={job.scope} skill={job.skill} />
      <div className="tray-line">
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
            {review}
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

function HeldRow({ request }: { request: HeldRequest }) {
  return (
    <li className="tray-job" data-state="held">
      <TurnHeader
        doc={request.request.doc}
        instruction={request.request.instruction}
        scope={request.request.scope}
        skill={request.request.skill}
      />
      <div className="tray-line">
        <span className="tray-state">queued behind another job</span>
      </div>
      <div className="tray-actions">
        <button type="button" className="link" onClick={() => dropHeld(request.id)}>
          Cancel
        </button>
      </div>
    </li>
  )
}

/**
 * The count moves between the panel and the corner when the panel opens or closes: a keyboard user
 * holding it keeps holding it, in its new place. Call before the change that moves it.
 */
function handOverFocus(from: EventTarget, to: string): void {
  if (document.activeElement === from) focusWhenMounted(() => document.querySelector(to))
}

/** Every job of this workspace, oldest first, and the one-line count that sums them up. */
function useTranscript() {
  const jobs = useJobs((state) => state.jobs)
  const order = useJobs((state) => state.order)
  const held = useJobs((state) => state.held)
  const list = order.flatMap((id) => (jobs[id] === undefined ? [] : [jobs[id]]))
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
  return { list, held, label, empty: list.length === 0 && held.length === 0 }
}

/**
 * The agent conversation, in the right panel: each job is a turn — what the writer asked, then
 * what came of it — under the one-line count. It exists only while there is a job.
 */
export function Transcript() {
  const { list, held, label, empty } = useTranscript()
  if (empty) return null
  return (
    <section className="tray transcript" aria-label="Agent jobs">
      <button
        type="button"
        className="tray-toggle"
        aria-expanded={true}
        onMouseDown={keepFocus}
        onClick={(event) => {
          handOverFocus(event.currentTarget, '.tray-corner > .tray-toggle')
          setRightOpen(false)
        }}
      >
        {label}
      </button>
      <ul className="tray-list">
        {list.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
        {held.map((request) => (
          <HeldRow key={request.id} request={request} />
        ))}
      </ul>
    </section>
  )
}

/**
 * The same count, bottom right, wherever the agent panel is not beside the text — closed, or
 * stacked after the article on a narrow window — so running, failed and stale work never leaves
 * the writer's sight. Clicking it opens the panel, or scrolls to it.
 */
export function JobCount() {
  const { label, empty } = useTranscript()
  const layout = useShell((state) => layoutOf(state).right)
  if (empty || layout === 'docked') return null
  const count = (
    <button
      type="button"
      className="tray-toggle"
      aria-expanded={false}
      onMouseDown={keepFocus}
      onClick={(event) => {
        if (layout === 'closed') {
          handOverFocus(event.currentTarget, '.transcript > .tray-toggle')
          setRightOpen(true)
        }
        revealRightIfStacked()
      }}
    >
      {label}
    </button>
  )
  // While the transcript is mounted (stacked), the corner copy is not a second "Agent jobs" region.
  return layout === 'closed' ? (
    <section className="tray tray-corner" aria-label="Agent jobs">
      {count}
    </section>
  ) : (
    <div className="tray tray-corner">{count}</div>
  )
}
