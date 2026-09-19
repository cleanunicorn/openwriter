import { defaultKeymap, history, redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { DocRef } from '../../shared/api-types.ts'
import { api } from '../api.ts'
import { editorSelection } from '../jobs/selection.ts'
import { dispatchDoc } from '../state/app.ts'
import type { FocusCursor } from '../state/doc-reducer.ts'

type Props = { docRef: DocRef; id: string; initialText: string; cursor: FocusCursor }

const isInsideOpenFence = (text: string) =>
  (text.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1

function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'))
}

/** The editing state of one block: a CodeMirror instance created on focus, destroyed on blur. */
export function BlockEditor({ docRef, id, initialText, cursor }: Props) {
  const host = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once per focus
  useEffect(() => {
    if (host.current === null) return
    // Destroying a focused view can fire `blur`; that must not count as the writer leaving.
    let destroyed = false
    const text = (view: EditorView) => view.state.doc.toString()
    const send = (action: Parameters<typeof dispatchDoc>[1]) => dispatchDoc(docRef, action)
    /** Dispatch and report the key as handled. */
    const handled = (action: Parameters<typeof dispatchDoc>[1]) => {
      send(action)
      return true
    }

    const insertImages = async (view: EditorView, files: File[]) => {
      if (docRef.kind !== 'article') return
      for (const file of files) {
        try {
          const { name } = await api.uploadImage(docRef.slug, file)
          view.dispatch(view.state.replaceSelection(`![](${name})`))
        } catch (error) {
          send({ type: 'notice', notice: `Could not add the image: ${(error as Error).message}` })
        }
      }
    }

    const atVisualEdge = (view: EditorView, forward: boolean) => {
      const range = view.state.selection.main
      return range.empty && view.moveVertically(range, forward).head === range.head
    }

    const keys = keymap.of([
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
          const onEmptyLastLine =
            range.empty && range.head === state.doc.length && last.length === 0
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
      {
        key: 'Mod-Shift-z',
        run: (view) => (redoDepth(view.state) > 0 ? redo(view) : handled({ type: 'redo' })),
      },
      {
        key: 'Mod-y',
        run: (view) => (redoDepth(view.state) > 0 ? redo(view) : handled({ type: 'redo' })),
      },
    ])

    const anchor =
      cursor === 'start'
        ? 0
        : cursor === 'end'
          ? initialText.length
          : Math.min(cursor, initialText.length)
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialText,
        selection: EditorSelection.cursor(anchor),
        extensions: [
          keys,
          history(),
          keymap.of(defaultKeymap),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Block editor', 'data-block-id': id }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) send({ type: 'draft', id, text: text(update.view) })
            if (update.selectionSet || update.docChanged) {
              const range = update.state.selection.main
              editorSelection.current = range.empty
                ? null
                : {
                    id,
                    from: range.from,
                    to: range.to,
                    text: update.state.sliceDoc(range.from, range.to),
                  }
            }
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
    view.focus()
    return () => {
      destroyed = true
      view.destroy()
    }
  }, [id])

  return <div ref={host} className="block-editor" />
}
