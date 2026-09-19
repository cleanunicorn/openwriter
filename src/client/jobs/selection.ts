import { useEffect, useState } from 'react'
import { currentDoc, dispatch, store } from '../state/app.ts'
import type { PillTarget } from './PromptPill.tsx'

/** The focused editor publishes its selection here; the DOM selection knows no source offsets. */
export const editorSelection: {
  current: { id: string; from: number; to: number; text: string } | null
} = {
  current: null,
}

const column = () => document.querySelector<HTMLElement>('.column')

/** Anchor the pill to a block: just below `rect`, or above the block when there is none. */
function anchorFor(block: HTMLElement, rect: DOMRect | null): PillTarget['anchor'] {
  const host = column()?.getBoundingClientRect()
  const blockRect = block.getBoundingClientRect()
  const blockId = block.dataset.blockId
  if (host === undefined || blockId === undefined) return null
  if (rect === null) return { blockId, offsetTop: -46, left: 0 }
  return {
    blockId,
    offsetTop: rect.bottom - blockRect.top + 8,
    left: Math.max(0, Math.min(rect.left - host.left, host.width - 420)),
  }
}

/** Work out what the writer selected: text in the editor, text in a rendered block, or blocks. */
function targetFromSelection(): PillTarget | null {
  const state = currentDoc(store.get())
  if (state === null || state.status !== 'ready') return null
  const docRef = state.ref

  if (state.selectedIds.length > 0) {
    // Above the first selected block, so it never covers the blocks a shift-click extends to.
    const first = state.selectedIds[0]
    const element = document.querySelector<HTMLElement>(
      `[data-testid="block"][data-block-id="${first}"]`,
    )
    if (element === null) return null
    return { docRef, targets: state.selectedIds, anchor: anchorFor(element, null) }
  }

  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const container = range.commonAncestorContainer
  const element = container instanceof Element ? container : container.parentElement
  if (element === null || element.closest('.blocks') === null) return null
  if (element.closest('.ghost') !== null) return null
  const block = element.closest<HTMLElement>('[data-testid="block"]')
  const blockId = block?.dataset.blockId
  if (
    block === null ||
    blockId === undefined ||
    !state.doc.blocks.some((candidate) => candidate.id === blockId)
  ) {
    return null
  }
  const text = selection.toString()
  if (text.trim() === '') return null
  const fromEditor = editorSelection.current
  const exact =
    fromEditor !== null && fromEditor.id === blockId && element.closest('.cm-editor') !== null
  return {
    docRef,
    targets: [blockId],
    selection: exact
      ? { blockId, text: fromEditor.text, from: fromEditor.from, to: fromEditor.to }
      : { blockId, text },
    anchor: anchorFor(block, range.getBoundingClientRect()),
    // Inside an editor the keyboard belongs to the text: typing replaces the selection, Shift+Arrow
    // extends it, Ctrl/Cmd+C copies it. The pill says how to reach it instead of taking focus.
    placeholder: exact ? 'Press Ctrl/Cmd+I, then tell the agent what to do' : undefined,
  }
}

/**
 * The prompt pill appears after a selection gesture ends (mouseup, or a shifted key for keyboard
 * selections) and nowhere else: nothing is on screen until the writer reaches for it.
 */
export function useSelectionPill(): [PillTarget | null, (target: PillTarget | null) => void] {
  const [target, setTarget] = useState<PillTarget | null>(null)

  useEffect(() => {
    const update = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.pill, .palette, .tray, .research') !== null
      )
        return
      // Let the click that ends a gesture settle (selection state, block selection) first.
      requestAnimationFrame(() => setTarget(targetFromSelection()))
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || event.shiftKey) update(event)
    }
    const focusPill = () => document.querySelector<HTMLInputElement>('.pill-input')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (
        mod &&
        event.key.toLowerCase() === 'i' &&
        document.querySelector('.pill-input') !== null
      ) {
        // The explicit way into the pill, also from inside the editor.
        event.preventDefault()
        focusPill()
        return
      }
      const typing =
        event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, select, [contenteditable="true"], .ghost') !== null
      if (!mod && !event.altKey && event.key.length === 1 && !typing) {
        // Outside an editor, just start typing: the character lands in the pill.
        focusPill()
        return
      }
      if (event.key === 'Escape' && (currentDoc(store.get())?.selectedIds.length ?? 0) > 0) {
        dispatch({ type: 'select', ids: [] })
        setTarget(null)
      }
    }
    document.addEventListener('mouseup', update)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mouseup', update)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return [target, setTarget]
}
