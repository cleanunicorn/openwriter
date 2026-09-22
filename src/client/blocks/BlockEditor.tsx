import { defaultKeymap, history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { useLayoutEffect, useRef } from 'react'
import type { DocRef } from '../../shared/api-types.ts'
import { api } from '../api.ts'
import { editorSelection } from '../jobs/selection.ts'
import { dispatchDoc } from '../state/app.ts'
import type { DocAction, FocusCursor } from '../state/doc-reducer.ts'

type Props = {
  docRef: DocRef
  id: string
  initialText: string
  cursor: FocusCursor
  /**
   * Changes when the reducer replaced this block's draft — a reload folded the editor's text
   * into the document, or a rescue moved it. The view is updated in place rather than rebuilt:
   * React runs effect cleanup after it has already removed the node, so a rebuild would let the
   * old view's `blur` commit the text we are replacing.
   */
  seed?: number
}

const isInsideOpenFence = (text: string) =>
  (text.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'))
}

const text = (view: EditorView) => view.state.doc.toString()

/** What the server's SVG sanitiser took out of a pasted SVG, in one short sentence, or null. */
export function removedNotice(name: string, removed: string[]): string | null {
  if (removed.length === 0) return null
  const shown = removed.slice(0, 4).join(', ')
  const more = removed.length > 4 ? ` and ${removed.length - 4} more` : ''
  return `Removed from ${name} for safety: ${shown}${more}.`
}

const atVisualEdge = (view: EditorView, forward: boolean) => {
  const range = view.state.selection.main
  return range.empty && view.moveVertically(range, forward).head === range.head
}

/** The keys that leave the block or hand over to the document; CodeMirror owns the rest. */
function blockKeymap(id: string, send: (action: DocAction) => void) {
  /** Dispatch and report the key as handled. */
  const handled = (action: DocAction) => {
    send(action)
    return true
  }

  const runRedo = (view: EditorView) =>
    redoDepth(view.state) > 0 ? redo(view) : handled({ type: 'redo' })

  return keymap.of([
    { key: 'Escape', run: (view) => handled({ type: 'commit', id, text: text(view) }) },
    {
      key: 'ArrowUp',
      run: (view) =>
        atVisualEdge(view, false)
          ? handled({ type: 'focus-neighbour', id, text: text(view), direction: -1 })
          : false,
    },
    {
      key: 'ArrowDown',
      run: (view) =>
        atVisualEdge(view, true)
          ? handled({ type: 'focus-neighbour', id, text: text(view), direction: 1 })
          : false,
    },
    {
      // Enter on an empty last line creates a new block — but never inside an open code fence.
      key: 'Enter',
      run: (view) => {
        const { state } = view
        const range = state.selection.main
        const last = state.doc.line(state.doc.lines)
        const onEmptyLastLine = range.empty && range.head === state.doc.length && last.length === 0
        if (!onEmptyLastLine || state.doc.lines < 2 || isInsideOpenFence(text(view))) return false
        send({
          type: 'new-block',
          currentId: id,
          currentText: text(view).replace(/(\r\n|\r|\n)$/, ''),
        })
        return true
      },
    },
    {
      key: 'Backspace',
      run: (view) => {
        const range = view.state.selection.main
        if (!range.empty || range.head !== 0) return false
        send({ type: 'merge-previous', id, text: text(view) })
        return true
      },
    },
    // Inside a block CodeMirror owns undo; once it has nothing left, the document stack takes over.
    {
      key: 'Mod-z',
      run: (view) => (undoDepth(view.state) > 0 ? undo(view) : handled({ type: 'undo' })),
    },
    { key: 'Mod-Shift-z', run: runRedo },
    { key: 'Mod-y', run: runRedo },
  ])
}

/** Publish the selection for the prompt pill: the DOM selection knows no source offsets. */
function publishSelection(id: string, update: ViewUpdate) {
  const range = update.state.selection.main
  editorSelection.current = range.empty
    ? null
    : { id, from: range.from, to: range.to, text: update.state.sliceDoc(range.from, range.to) }
}

/** The editing state of one block: a CodeMirror instance created on focus, destroyed on blur. */
export function BlockEditor({ docRef, id, initialText, cursor, seed }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const applied = useRef(seed)

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new seed replaces the text
  useLayoutEffect(() => {
    const current = view.current
    if (current === null || seed === applied.current) return
    applied.current = seed
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: initialText },
      selection: EditorSelection.cursor(initialText.length),
    })
  }, [seed])

  // The view's life is a layout effect, not a passive one. React runs passive cleanup *after*
  // it has removed the node, and removing a focused node makes the browser fire `blur` — which
  // would commit this editor's text one more time, into a document that already has it. A
  // layout cleanup runs before the removal, so the view is gone before the blur can happen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once per focus
  useLayoutEffect(() => {
    if (host.current === null) return
    // Destroying a focused view can fire `blur`; that must not count as the writer leaving.
    let destroyed = false
    const send = (action: DocAction) => dispatchDoc(docRef, action)

    const insertImages = async (view: EditorView, files: File[]) => {
      if (docRef.kind !== 'article') return
      for (const file of files) {
        try {
          const { name, removed } = await api.uploadImage(docRef.slug, file)
          const cleaned = removedNotice(name, removed)
          if (destroyed) {
            // The file is in the bundle, but the editor it was meant for closed meanwhile.
            send({
              type: 'notice',
              notice: `The image was saved as ${name}, but its editor had closed. Add ![](${name}) where you want it.${cleaned === null ? '' : ` ${cleaned}`}`,
            })
            continue
          }
          view.dispatch(view.state.replaceSelection(`![](${name})`))
          if (cleaned !== null) send({ type: 'notice', notice: cleaned })
        } catch (error) {
          send({ type: 'notice', notice: `Could not add the image: ${(error as Error).message}` })
        }
      }
    }

    const anchor =
      cursor === 'start'
        ? 0
        : cursor === 'end'
          ? initialText.length
          : Math.min(cursor, initialText.length)
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialText,
        selection: EditorSelection.cursor(anchor),
        extensions: [
          blockKeymap(id, send),
          history(),
          keymap.of(defaultKeymap),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Block editor', 'data-block-id': id }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) send({ type: 'draft', id, text: text(update.view) })
            if (update.selectionSet || update.docChanged) publishSelection(id, update)
          }),
          EditorView.domEventHandlers({
            blur: (_event, current) => {
              if (!destroyed) send({ type: 'commit', id, text: text(current) })
            },
            paste: (event, current) => {
              const files = imageFiles(event.clipboardData)
              if (files.length === 0) return false
              event.preventDefault()
              void insertImages(current, files)
              return true
            },
            drop: (event, current) => {
              const files = imageFiles(event.dataTransfer)
              if (files.length === 0) return false
              event.preventDefault()
              void insertImages(current, files)
              return true
            },
          }),
        ],
      }),
    })
    editor.focus()
    view.current = editor
    return () => {
      destroyed = true
      view.current = null
      editor.destroy()
    }
  }, [id])

  return <div ref={host} className="block-editor" />
}
