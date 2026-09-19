import { splitText } from '../../shared/blocks/index.ts'
import { RenderedBlock } from '../blocks/RenderedBlock.tsx'
import { dismissJob, insertNote, setResearchJob, useJobs } from '../state/jobs.ts'

/** Research answers never touch the article; the writer inserts what is useful as new blocks. */
export function ResearchPanel() {
  const job = useJobs((state) =>
    state.researchJobId === null ? undefined : state.jobs[state.researchJobId],
  )
  if (job === undefined || job.result === null) return null
  const notes = splitText(job.result.notes).slices

  return (
    <aside className="research" aria-label="Research notes">
      <header className="research-header">
        <span className="quiet">Research · {job.instruction}</span>
        <button type="button" className="link" onClick={() => setResearchJob(null)}>
          Close
        </button>
      </header>
      <p className="research-summary">{job.result.summary}</p>
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
          Done with these notes
        </button>
      </footer>
    </aside>
  )
}
