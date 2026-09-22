import { splitText } from '../../shared/blocks/index.ts'
import type { Job } from '../../shared/jobs/job-types.ts'
import type { Result } from '../../shared/jobs/result-schema.ts'
import { RenderedBlock } from '../blocks/RenderedBlock.tsx'
import { dismissJob, insertNote, setResearchJob, useJobs } from '../state/jobs.ts'
import { useRestoreFocus } from '../use-restore-focus.ts'

/**
 * Research answers never touch the article; the writer inserts what is useful as new blocks. The
 * notes show at the top of the agent panel, which never covers the text (see shell/layout.ts).
 */
export function ResearchPanel() {
  const job = useJobs((state) =>
    state.researchJobId === null ? undefined : state.jobs[state.researchJobId],
  )
  if (job === undefined || job.result === null) return null
  return <OpenPanel job={job} result={job.result} />
}

/** Mounted only while the panel is open, so the focus hook runs per opening. */
function OpenPanel({ job, result }: { job: Job; result: Result }) {
  useRestoreFocus()
  const notes = splitText(result.notes).slices

  return (
    <aside className="research" aria-label="Research notes">
      <header className="research-header">
        <span className="quiet">Research · {job.instruction}</span>
        <button type="button" className="link" onClick={() => setResearchJob(null)}>
          Close
        </button>
      </header>
      <p className="research-summary">{result.summary}</p>
      {notes.map((note, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: notes are static for a finished job
        <div key={index} className="research-note">
          <RenderedBlock raw={note.raw} assetBase={`/api/jobs/${job.id}/`} />
          <button type="button" className="link" onClick={() => insertNote(job, note.raw)}>
            Insert as block
          </button>
        </div>
      ))}
      {notes.length === 0 && <p className="quiet">The agent returned no notes.</p>}
      <footer className="research-footer">
        <button type="button" className="link" onClick={() => void dismissJob(job.id)}>
          Discard these notes
        </button>
      </footer>
    </aside>
  )
}
