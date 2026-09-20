import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
} from 'react'
import { dispatchDoc } from '../state/app.ts'
import { type DocState, NEW_BLOCK_ID } from '../state/doc-reducer.ts'
import { Block, type Decoration } from './Block.tsx'
import { BlockEditor } from './BlockEditor.tsx'
import { clickToOffset } from './click-to-offset.ts'

type Props = {
  state: DocState
  /** Per-block decorations and extra rows (ghost inserts) from the job layer. */
  decorate?: (blockId: string) => Decoration | undefined
  rowsAfter?: (blockId: string | null) => ReactNode
}

/** Blocks between two IDs, inclusive, in document order. The front matter is never selected. */
function rangeOf(state: DocState, fromId: string, toId: string): string[] {
  const ids = state.doc.blocks.filter((block) => block.kind === 'content').map((block) => block.id)
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (to === -1) return []
  if (from === -1) return [toId]
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1)
}

export function BlockList({ state, decorate, rowsAfter }: Props) {
  const { ref: docRef, doc, draft, focusedId, focusCursor, pendingNew, selectedIds } = state
  const assetBase = docRef.kind === 'article' ? `/api/docs/article/${docRef.slug}/assets/` : null
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // A click enters edit mode. The cursor is computed at mousedown, while the layout is still the
  // one the writer aimed at (a blur elsewhere may re-render before mouseup); a drag that selects
  // text never enters edit mode, so text in a rendered block can be selected for a prompt.
  const pressed = useRef<{ id: string; cursor: number } | null>(null)
  // Dragging along the left margin selects whole blocks.
  const marginAnchor = useRef<string | null>(null)
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (marginAnchor.current === null) return
      const over = document
        .elementFromPoint(Math.max(event.clientX, 0) + 60, event.clientY)
        ?.closest<HTMLElement>('[data-testid="block"]')?.dataset.blockId
      if (over !== undefined) {
        dispatchDoc(docRef, {
          type: 'select',
          ids: rangeOf(latest.current, marginAnchor.current, over),
        })
      }
    }
    const onMouseUp = () => {
      marginAnchor.current = null
      const press = pressed.current
      pressed.current = null
      if (press === null) return
      const selection = window.getSelection()
      if (selection !== null && !selection.isCollapsed) return
      dispatchDoc(docRef, { type: 'focus', id: press.id, cursor: press.cursor })
    }
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onMouseMove)
    return () => {
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [docRef])

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as Element
    const element = target.closest<HTMLElement>('[data-testid="block"]')
    const id = element?.dataset.blockId
    const block = doc.blocks.find((candidate) => candidate.id === id)
    if (target.closest('.gutter') !== null && target.closest('.drag-handle') === null) {
      if (block === undefined || block.kind === 'frontmatter') return
      event.preventDefault()
      marginAnchor.current = block.id
      dispatchDoc(docRef, { type: 'select', ids: [block.id] })
      return
    }
    if (target.closest('.gutter, .block-editor, .ghost, button, a, input, textarea') !== null)
      return
    if (element === null || block === undefined) return
    if (event.shiftKey && block.kind === 'content') {
      // Shift-click extends a block selection from the focused or first selected block.
      event.preventDefault()
      const anchor = selectedIds[0] ?? focusedId ?? block.id
      dispatchDoc(docRef, { type: 'blur' })
      dispatchDoc(docRef, { type: 'select', ids: rangeOf(state, anchor, block.id) })
      return
    }
    const cursor =
      block.kind === 'frontmatter'
        ? 0
        : clickToOffset(block.raw, target, event.clientX, event.clientY)
    pressed.current = { id: block.id, cursor }
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return
    const from = doc.blocks.findIndex((block) => block.id === active.id)
    const to = doc.blocks.findIndex((block) => block.id === over.id)
    if (from !== -1 && to !== -1) dispatchDoc(docRef, { type: 'move', from, to })
  }

  const newSlot = (afterId: string | null) =>
    pendingNew !== null && pendingNew.afterId === afterId && focusedId === NEW_BLOCK_ID ? (
      <div className="block is-focused" data-testid="block" data-block-id={NEW_BLOCK_ID}>
        <div className="gutter" />
        <div className="block-body">
          <BlockEditor
            docRef={docRef}
            id={NEW_BLOCK_ID}
            // The slot moves when its anchor goes (an accepted op can delete it), and React
            // builds a fresh editor at the new position: seed it with what is being typed.
            initialText={draft?.id === NEW_BLOCK_ID ? draft.text : ''}
            cursor="start"
          />
        </div>
      </div>
    ) : null

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext
        items={doc.blocks.map((block) => block.id)}
        strategy={verticalListSortingStrategy}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse entry into edit mode; keyboard users tab to blocks */}
        <div className="blocks" onMouseDown={onMouseDown}>
          {newSlot(null)}
          {rowsAfter?.(null)}
          {doc.blocks.map((block) => (
            <Fragment key={block.id}>
              <Block
                docRef={docRef}
                block={block}
                focused={focusedId === block.id}
                cursor={focusCursor}
                selected={selectedIds.includes(block.id)}
                draftText={draft?.id === block.id ? draft.text : undefined}
                assetBase={assetBase}
                decoration={decorate?.(block.id)}
              />
              {rowsAfter?.(block.id)}
              {newSlot(block.id)}
            </Fragment>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
