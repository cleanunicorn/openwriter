import { diffWordsWithSpace } from 'diff'
import { type KeyboardEvent, type ReactNode, useMemo } from 'react'
import { docKey } from '../../shared/api-types.ts'
import type { Job } from '../../shared/jobs/job-types.ts'
import type { Op } from '../../shared/jobs/result-schema.ts'
import { changedSinceRequest } from '../../shared/jobs/scheduler.ts'
import { START_ANCHOR } from '../../shared/jobs/validate-ops.ts'
import { RenderedBlock } from '../blocks/RenderedBlock.tsx'
import type { DocState } from '../state/doc-reducer.ts'
import { acceptAll, claimsOn, decide, rejectAll, undecided, useJobs } from '../state/jobs.ts'

type Decoration = { className?: string; overlay?: ReactNode; replaceBody?: ReactNode }

const focusNextGhost = () =>
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.ghost')?.focus())

function Ghost(props: {
  job: Job
  index: number
  total: number
  op: Op
  first: boolean
  changed: boolean
  children: ReactNode
}) {
  const { job, index, op, first, changed } = props
  const accept = () => void decide(job.id, [index], []).then(focusNextGhost)
  const reject = () => void decide(job.id, [], [index]).then(focusNextGhost)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Enter' || event.key === 'a') {
      event.preventDefault()
      if (mod) void acceptAll(job.id).then(focusNextGhost)
      else accept()
    } else if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'r') {
      event.preventDefault()
      if (mod) void rejectAll(job.id).then(focusNextGhost)
      else reject()
    }
  }
  // Keep the keyboard where it is: without this, pressing a button blurs an open editor, the
  // block re-renders, the layout shifts, and the click misses the button.
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()
  const kind = op.op === 'replace' ? 'replacement' : op.op === 'delete' ? 'deletion' : 'insertion'
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the ghost; role=group is enough
    <div
      className={`ghost ghost-${op.op}`}
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a proposal is reviewed from the keyboard (Enter / Backspace)
      tabIndex={0}
      aria-label={`Proposed ${kind} ${index + 1} of ${props.total}`}
      data-testid="ghost"
      data-job-id={job.id}
      onKeyDown={onKeyDown}
    >
      {first && (
        <div className="ghost-job">
          <span className="ghost-summary">{job.result?.summary}</span>
          <button
            type="button"
            className="link"
            onMouseDown={keepFocus}
            onClick={() => void acceptAll(job.id)}
          >
            Accept all
          </button>
          <button
            type="button"
            className="link"
            onMouseDown={keepFocus}
            onClick={() => void rejectAll(job.id)}
          >
            Reject all
          </button>
        </div>
      )}
      {changed && (
        <div className="ghost-flag">changed since request — compared with your current text</div>
      )}
      <div className="ghost-body">{props.children}</div>
      <div className="ghost-actions">
        <button type="button" className="link" onMouseDown={keepFocus} onClick={accept}>
          Accept
        </button>
        <button type="button" className="link" onMouseDown={keepFocus} onClick={reject}>
          Reject
        </button>
      </div>
    </div>
  )
}

/** Inline word diff of the markdown source, always against the block's current text. */
function SourceDiff({ current, proposed }: { current: string; proposed: string }) {
  const parts = useMemo(() => diffWordsWithSpace(current, proposed), [current, proposed])
  return (
    <div className="ghost-diff">
      {parts.map((part, index) =>
        part.added ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff parts are positional
          <ins key={index}>{part.value}</ins>
        ) : part.removed ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff parts are positional
          <del key={index}>{part.value}</del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff parts are positional
          <span key={index}>{part.value}</span>
        ),
      )}
    </div>
  )
}

/**
 * Ghost diffs overlay the live document without changing it: replacements as inline diffs,
 * insertions as ghost blocks, deletions struck through. The editor itself knows nothing about
 * jobs — it only receives decorations and extra rows.
 */
export function useGhosts(state: DocState | null): {
  decorate: (blockId: string) => Decoration | undefined
  rowsAfter: (blockId: string | null) => ReactNode
} {
  const jobsState = useJobs((jobs) => jobs)
  return useMemo(() => {
    const decorations = new Map<string, Decoration>()
    const rows = new Map<string | null, ReactNode[]>()
    if (state === null) return { decorate: () => undefined, rowsAfter: () => null }

    const { pending, queued } = claimsOn(jobsState, state.ref)
    for (const id of queued) decorations.set(id, { className: 'is-queued' })
    for (const id of pending) decorations.set(id, { className: 'is-pending' })

    const blocks = state.doc.blocks
    const indexOf = (id: string) => blocks.findIndex((block) => block.id === id)
    const addRow = (after: string | null, node: ReactNode) =>
      rows.set(after, [...(rows.get(after) ?? []), node])

    for (const jobId of jobsState.order) {
      const job = jobsState.jobs[jobId]
      if (job === undefined || job.state !== 'ready' || job.result === null) continue
      if (docKey(job.doc) !== docKey(state.ref)) continue
      const open = undecided(job)
      const total = job.result.ops.length
      open.forEach((opIndex, position) => {
        const op = job.result?.ops[opIndex]
        if (op === undefined) return
        const at = indexOf(op.block_id)
        const block = blocks[at]
        const wrap = (children: ReactNode, changed = false) => (
          <Ghost
            key={`${job.id}:${opIndex}`}
            job={job}
            index={opIndex}
            total={total}
            op={op}
            first={position === 0}
            changed={changed}
          >
            {children}
          </Ghost>
        )
        if (op.op === 'replace' || op.op === 'delete') {
          if (block === undefined) return
          const changed = changedSinceRequest(job.snapshotRaws, block.id, block.raw)
          decorations.set(block.id, {
            className: 'has-ghost',
            replaceBody: wrap(
              op.op === 'replace' ? (
                <SourceDiff current={block.raw} proposed={op.markdown} />
              ) : (
                <RenderedBlock raw={block.raw} assetBase={null} className="ghost-struck" />
              ),
              changed,
            ),
          })
          return
        }
        const ghost = wrap(<RenderedBlock raw={op.markdown} assetBase={`/api/jobs/${job.id}/`} />)
        if (op.block_id === START_ANCHOR) addRow(blocks[blocks.length - 1]?.id ?? null, ghost)
        else if (block === undefined) return
        else if (op.op === 'insert_after') addRow(block.id, ghost)
        else addRow(blocks[at - 1]?.id ?? null, ghost)
      })
    }
    return {
      decorate: (blockId: string) => decorations.get(blockId),
      rowsAfter: (blockId: string | null) => rows.get(blockId) ?? null,
    }
  }, [state, jobsState])
}
