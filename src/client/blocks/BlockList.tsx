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
import { Block } from './Block.tsx'
import { BlockEditor } from './BlockEditor.tsx'
import { clickToOffset } from './click-to-offset.ts'

type Decoration = { className?: string; overlay?: ReactNode; replaceBody?: ReactNode }

type Props = {
  state: DocState
  /** Per-block decorations and extra rows (ghost inserts) from the job layer. */
  decorate?: (blockId: string) => Decoration | undefined
  rowsAfter?: (blockId: string | null) => ReactNode
  onShiftSelect?: (blockId: string) => void
}

export function BlockList({ state, decorate, rowsAfter, onShiftSelect }: Props) {
  const { ref: docRef, doc, focusedId, focusCursor, pendingNew, selectedIds } = state
  const assetBase = docRef.kind === 'article' ? `/api/docs/article/${docRef.slug}/assets/` : null
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // A click enters edit mode. The cursor is computed at mousedown, while the layout is still the
  // one the writer aimed at (a blur elsewhere may re-render before mouseup); a drag that selects
  // text never enters edit mode, so text in a rendered block can be selected for a prompt.
  const pressed = useRef<{ id: string; cursor: number } | null>(null)
  useEffect(() => {
    const onMouseUp = () => {
      const press = pressed.current
      pressed.current = null
      if (press === null) return
      const selection = window.getSelection()
      if (selection !== null && !selection.isCollapsed) return
      dispatchDoc(docRef, { type: 'focus', id: press.id, cursor: press.cursor })
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [docRef])

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as Element
    if (target.closest('.gutter, .block-editor, .ghost, button, a, input, textarea') !== null)
      return
    const element = target.closest<HTMLElement>('[data-testid="block"]')
    const id = element?.dataset.blockId
    const block = doc.blocks.find((candidate) => candidate.id === id)
    if (element == null || block === undefined) return
    if (event.shiftKey && onShiftSelect !== undefined) {
      event.preventDefault()
      onShiftSelect(block.id)
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
          <BlockEditor docRef={docRef} id={NEW_BLOCK_ID} initialText="" cursor="start" />
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
