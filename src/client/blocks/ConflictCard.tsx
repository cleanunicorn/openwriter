import type { DocRef } from '../../shared/api-types.ts'
import { keepFocus } from '../keep-focus.ts'
import { dispatchDoc } from '../state/app.ts'
import type { Conflict, ConflictChoice } from '../state/doc-reducer.ts'
import { SourceDiff } from './SourceDiff.tsx'

/**
 * A passage the file and this tab both changed (a reload found it; see `Conflict`). It sits right
 * after the file's version, which is what the document shows, and holds the writer's version as
 * a word diff against it until the writer chooses. Nothing is saved over the file meanwhile.
 */
export function ConflictCard(props: {
  docRef: DocRef
  conflict: Conflict
  index: number
  total: number
}) {
  const { docRef, conflict, index, total } = props
  const choose = (keep: ConflictChoice) =>
    dispatchDoc(docRef, { type: 'resolve', id: conflict.id, keep })
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would restyle the card; role=group is enough
    <div
      className="conflict"
      role="group"
      aria-label={total === 1 ? 'Conflict' : `Conflict ${index + 1} of ${total}`}
    >
      <p className="conflict-head">
        Changed on disk while you were editing it. Above is the file’s version; yours, not saved:
      </p>
      <SourceDiff current={conflict.theirs} proposed={conflict.mine} />
      <div className="conflict-actions">
        <button
          type="button"
          className="link"
          onMouseDown={keepFocus}
          onClick={() => choose('mine')}
        >
          Keep mine
        </button>
        <button
          type="button"
          className="link"
          onMouseDown={keepFocus}
          onClick={() => choose('theirs')}
        >
          Take theirs
        </button>
        <button
          type="button"
          className="link"
          onMouseDown={keepFocus}
          onClick={() => choose('both')}
        >
          Keep both
        </button>
      </div>
    </div>
  )
}

/** The block a conflict's card goes after: the last of the file's blocks, or the one before them. */
export function conflictAnchor(blockIds: string[], afterId: string | null, present: string[]) {
  const shown = blockIds.filter((id) => present.includes(id))
  const last = shown[shown.length - 1]
  if (last !== undefined) return last
  if (afterId === null || present.includes(afterId)) return afterId
  return present[present.length - 1] ?? null
}
