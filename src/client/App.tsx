import { useEffect } from 'react'
import { BlockList } from './blocks/BlockList.tsx'
import { useGhosts } from './jobs/GhostDiff.tsx'
import { PromptPill } from './jobs/PromptPill.tsx'
import { ResearchPanel } from './jobs/ResearchPanel.tsx'
import { useSelectionPill } from './jobs/selection.ts'
import { Tray } from './jobs/Tray.tsx'
import './jobs/commands.ts'
import { startJobs } from './state/jobs.ts'
import { applyTheme } from './palette/commands.ts'
import { Palette } from './palette/Palette.tsx'
import {
  connectEvents,
  currentDoc,
  dispatch,
  setPalette,
  start,
  store,
  useApp,
} from './state/app.ts'
import { NEW_BLOCK_ID } from './state/doc-reducer.ts'

const inTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"], .cm-editor') !== null

export function App() {
  const doc = useApp(currentDoc)
  const palette = useApp((state) => state.palette)
  const theme = useApp((state) => state.config?.config.theme)

  const ghosts = useGhosts(doc)
  const [pill, setPill] = useSelectionPill()

  useEffect(() => {
    startJobs()
    void start()
    return connectEvents()
  }, [])

  // Palette actions open the same pill with a preset scope or skill.
  useEffect(() => {
    const onAsk = (event: Event) => setPill((event as CustomEvent).detail)
    window.addEventListener('openwrite:ask', onAsk)
    return () => window.removeEventListener('openwrite:ask', onAsk)
  }, [setPill])

  useEffect(() => {
    if (theme !== undefined) applyTheme(theme)
  }, [theme])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette(store.get().palette === null ? { kind: 'commands' } : null)
        return
      }
      if (inTextField(event.target)) return
      // Document-level undo and redo when no editor has the keyboard.
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        dispatch({ type: 'redo' })
      } else if (event.key === 'Enter' && store.get().palette === null) {
        // Keyboard entry into the document: edit the first content block.
        const first = currentDoc(store.get())?.doc.blocks.find((block) => block.kind === 'content')
        if (first !== undefined) {
          event.preventDefault()
          dispatch({ type: 'focus', id: first.id, cursor: 'end' })
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <main className="column" data-doc-status={doc?.status ?? 'none'}>
        {doc?.notice != null && (
          <p className="notice" role="status" aria-label="Document notice">
            {doc.notice}{' '}
            <button
              type="button"
              className="link"
              onClick={() => dispatch({ type: 'notice', notice: null })}
            >
              Dismiss
            </button>
          </p>
        )}
        {doc === null && (
          <p className="quiet">No article yet. Press Ctrl/Cmd+K and choose “New article…”.</p>
        )}
        {doc?.status === 'loading' && <p className="quiet">Loading…</p>}
        {doc?.status === 'error' && (
          <p className="notice" role="alert">
            {doc.error}
          </p>
        )}
        {doc?.status === 'missing' && doc.notice === null && (
          <p className="notice" role="alert">
            This document does not exist on disk.
          </p>
        )}
        {doc !== null && (doc.status === 'ready' || doc.status === 'missing') && (
          <>
            {doc.ref.kind !== 'article' && (
              <p className="quiet doc-label">
                {doc.ref.kind === 'strategy' ? 'strategy.md' : `brief · ${doc.ref.slug}`}
              </p>
            )}
            <BlockList state={doc} decorate={ghosts.decorate} rowsAfter={ghosts.rowsAfter} />
            {!doc.doc.blocks.some((block) => block.kind === 'content') &&
              doc.focusedId !== NEW_BLOCK_ID && (
                <button
                  type="button"
                  className="link quiet"
                  onClick={() => dispatch({ type: 'append' })}
                >
                  Start writing
                </button>
              )}
          </>
        )}
        {pill !== null && (
          <PromptPill
            key={`${pill.anchor?.blockId}:${pill.anchor?.offsetTop}:${pill.targets.join()}`}
            target={pill}
            onClose={() => {
              setPill(null)
              dispatch({ type: 'select', ids: [] })
            }}
          />
        )}
      </main>
      <ResearchPanel />
      <Tray />
      {palette !== null && <Palette mode={palette} />}
    </>
  )
}
