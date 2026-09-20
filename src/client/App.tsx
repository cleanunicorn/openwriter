import { useEffect } from 'react'
import { BlockList } from './blocks/BlockList.tsx'
import { useGhosts } from './jobs/GhostDiff.tsx'
import { PromptPill } from './jobs/PromptPill.tsx'
import { ResearchPanel } from './jobs/ResearchPanel.tsx'
import { useSelectionPill } from './jobs/selection.ts'
import { Tray } from './jobs/Tray.tsx'
import './jobs/commands.ts'
import './export.ts'
import './settings/commands.ts'
import './workspaces/commands.ts'
import { Settings } from './settings/Settings.tsx'
import { startJobs } from './state/jobs.ts'
import { watchForWorkspaceChanges } from './workspaces/switch.ts'
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
  bumpThemeEpoch,
} from './state/app.ts'
import { NEW_BLOCK_ID } from './state/doc-reducer.ts'

const inTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"], .cm-editor') !== null

export function App() {
  const doc = useApp(currentDoc)
  const boot = useApp((state) => state.boot)
  const palette = useApp((state) => state.palette)
  const theme = useApp((state) => state.config?.config.theme)
  const panel = useApp((state) => state.panel)

  const ghosts = useGhosts(doc)
  const [pill, setPill] = useSelectionPill()

  useEffect(() => {
    startJobs()
    watchForWorkspaceChanges()
    void start()
    return connectEvents()
  }, [])

  useEffect(() => {
    if (theme !== undefined) applyTheme(theme)
  }, [theme])

  // With the "system" theme the OS can switch between light and dark at any time.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', bumpThemeEpoch)
    return () => media.removeEventListener('change', bumpThemeEpoch)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPalette(store.get().palette === null ? { kind: 'commands' } : null)
        return
      }
      // A modal panel owns the keyboard: no document undo or block focus behind it.
      if (store.get().panel !== null) return
      // A key that another control already handled (a ghost's Enter/Backspace) is not ours.
      if (event.defaultPrevented) return
      if (inTextField(event.target)) return
      // Document-level undo and redo when no editor has the keyboard.
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        dispatch({ type: 'redo' })
      } else if (event.key === 'Enter' && !mod && store.get().palette === null) {
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
        {doc !== null && doc.notice !== null && (
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
        {boot === 'loading' && doc === null && <p className="quiet">Loading…</p>}
        {typeof boot === 'object' && (
          <p className="notice" role="alert">
            openwrite could not load the workspace: {boot.error}{' '}
            <button type="button" className="link" onClick={() => void start()}>
              Retry
            </button>
          </p>
        )}
        {boot === 'ready' && doc === null && (
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
          // No key: extending the selection updates the pill in place and keeps what was typed.
          <PromptPill
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
      {panel === 'settings' && <Settings />}
      {palette !== null && <Palette mode={palette} />}
    </>
  )
}
