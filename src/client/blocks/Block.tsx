import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import type { DocRef } from '../../shared/api-types.ts'
import type { Block as BlockData } from '../../shared/blocks/index.ts'
import type { FocusCursor } from '../state/doc-reducer.ts'
import { BlockEditor } from './BlockEditor.tsx'
import { FrontMatterLine } from './FrontMatterLine.tsx'
import { RenderedBlock } from './RenderedBlock.tsx'

/** Pending marks, ghost diffs — supplied by the job layer; the editor knows nothing about it. */
export type Decoration = { className?: string; overlay?: ReactNode; replaceBody?: ReactNode }

type Props = {
  docRef: DocRef
  block: BlockData
  focused: boolean
  cursor: FocusCursor
  selected: boolean
  /**
   * What the editor for this block is holding, when it differs from the block's raw. A reload
   * can move the editor onto another block — the slot becomes real — and React then builds a
   * fresh CodeMirror; seeding it from the raw would show the disk's copy and throw away
   * whatever was typed since the save that reload is carrying.
   */
  draftText?: string
  assetBase: string | null
  decoration?: Decoration
}

export function Block({
  docRef,
  block,
  focused,
  cursor,
  selected,
  draftText,
  assetBase,
  decoration,
}: Props) {
  const fixed = block.kind === 'frontmatter'
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id, disabled: fixed || focused })

  const classes = [
    'block',
    focused && 'is-focused',
    selected && 'is-selected',
    isDragging && 'is-dragging',
  ]
  if (decoration?.className) classes.push(decoration.className)

  return (
    <div
      ref={setNodeRef}
      className={classes.filter(Boolean).join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="block"
      data-block-id={block.id}
      data-kind={block.kind}
    >
      <div className="gutter" data-testid="gutter">
        {!fixed && !focused && (
          <button
            type="button"
            className="drag-handle"
            data-testid="drag-handle"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
          >
            ⋮⋮
          </button>
        )}
      </div>
      <div className="block-body" data-testid="block-body">
        {focused ? (
          <BlockEditor
            docRef={docRef}
            id={block.id}
            initialText={draftText ?? block.raw}
            cursor={cursor}
          />
        ) : (
          (decoration?.replaceBody ??
          (fixed ? (
            <FrontMatterLine raw={block.raw} />
          ) : (
            <RenderedBlock raw={block.raw} assetBase={assetBase} />
          )))
        )}
        {decoration?.overlay}
      </div>
    </div>
  )
}
