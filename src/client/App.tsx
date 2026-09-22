import { useEffect } from 'react'
import { BlockList } from './blocks/BlockList.tsx'
import { docLabel } from './doc-label.ts'
import { useGhosts } from './jobs/GhostDiff.tsx'
import { PromptPill } from './jobs/PromptPill.tsx'
import { useSelectionPill } from './jobs/selection.ts'
import { JobCount } from './jobs/Tray.tsx'
import './jobs/commands.ts'
import './export.ts'
import './settings/commands.ts'
import './workspaces/commands.ts'
import { Settings } from './settings/Settings.tsx'
import { startJobs, useJobs } from './state/jobs.ts'
import { watchForWorkspaceChanges } from './workspaces/switch.ts'
import { applyTheme } from './palette/commands.ts'
import { Palette } from './palette/Palette.tsx'
import {
  connectEvents,
  createArticle,
  currentDoc,
  dispatch,
  setPalette,
  start,
  store,
  useApp,
  bumpThemeEpoch,
} from './state/app.ts'
import { NEW_BLOCK_ID } from './state/doc-reducer.ts'
import { routeKey } from './shell/keys.ts'
import { LeftPanel } from './shell/LeftPanel.tsx'
import { RightPanel } from './shell/RightPanel.tsx'
import { Shell } from './shell/Shell.tsx'
import { setRightOpen, toggleLeft, toggleRight } from './shell/state.ts'

const inTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, [contenteditable="true"], .cm-editor') !== null

/** Enter activates these itself; the document must not take it from them. */
const onControl = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('button, a[href], summary, select, [role="button"], [role="option"]') !== null

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

  // A research answer shows in the agent panel, opened for it; the keyboard stays where it is.
  // Here, not in the jobs store: the store knows jobs, the shell knows where things are shown.
  const researchJobId = useJobs((state) => state.researchJobId)
  useEffect(() => {
    if (researchJobId !== null) setRightOpen(true)
  }, [researchJobId])

  // With the "system" theme the OS can switch between light and dark at any time.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', bumpThemeEpoch)
    return () => media.removeEventListener('change', bumpThemeEpoch)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = store.get()
      const key = {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        defaultPrevented: event.defaultPrevented,
        altGraph: event.getModifierState('AltGraph'),
      }
      const action = routeKey(key, {
        modalOpen: state.panel !== null,
        paletteOpen: state.palette !== null,
        inTextField: inTextField(event.target),
        onControl: onControl(event.target),
      })
      if (action === null) return
      if (action === 'enter-document') {
        // Keyboard entry into the document: edit the first content block.
        const first = currentDoc(state)?.doc.blocks.find((block) => block.kind === 'content')
        if (first === undefined) return
        event.preventDefault()
        dispatch({ type: 'focus', id: first.id, cursor: 'end' })
        return
      }
      event.preventDefault()
      if (action === 'palette') setPalette(state.palette === null ? { kind: 'commands' } : null)
      // Toggling never moves the focus: the writer keeps typing where they were.
      else if (action === 'toggle-left') toggleLeft()
      else if (action === 'toggle-right') toggleRight()
      // Document-level undo and redo when no editor has the keyboard.
      else dispatch({ type: action })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <Shell left={<LeftPanel />} right={<RightPanel />}>
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
            <p className="quiet">
              No article yet.{' '}
              <button
                type="button"
                className="link"
                onClick={() =>
                  setPalette({
                    kind: 'input',
                    label: 'Article title',
                    placeholder: 'Title of the new article',
                    submit: (title) => void createArticle(title),
                  })
                }
              >
                New article
              </button>{' '}
              · your files are under Ctrl/Cmd+B
            </p>
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
                <p className="quiet doc-label">{docLabel(doc.ref, [])}</p>
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
      </Shell>
      <JobCount />
      {panel === 'settings' && <Settings />}
      {palette !== null && <Palette mode={palette} />}
    </>
  )
}
