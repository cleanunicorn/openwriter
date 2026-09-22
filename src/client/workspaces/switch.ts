import type { WorkspacesResponse } from '../../shared/workspaces-schema.ts'
import { api } from '../api.ts'
import { docLabel } from '../doc-label.ts'
import {
  configWritesSettled,
  flush,
  flushAll,
  notifyFailure,
  resetDocSession,
  resync,
  setEventHandlers,
  start,
  store,
  unsavedDocs,
} from '../state/app.ts'
import { resetJobs } from '../state/jobs.ts'

const remember = (workspaces: WorkspacesResponse) =>
  store.set((state) => ({ ...state, workspaces }))

const setSwitching = (switching: string | null) => store.set((state) => ({ ...state, switching }))

/**
 * Run one switch of this tab, with the document held still (`switching`) until it is over. While
 * it is set, a `workspace.changed` event is this tab's own, or one its own switch will overtake:
 * the response adopts, the event does not — adopting twice would clear what was typed in between.
 */
async function switching<T>(what: string, run: () => Promise<T>): Promise<T> {
  if (store.get().switching !== null) throw new Error('another workspace switch is under way')
  setSwitching(what)
  try {
    return await run()
  } finally {
    setSwitching(null)
  }
}

/**
 * Move the editor to the workspace the server has just opened.
 *
 * The document state is thrown away rather than reconciled: `resync()` compares every open
 * document with what is on disk, so one left in the store would be read as an *outside change*
 * to the new workspace's article of the same slug — the confusion AC2 forbids. `resetDocSession`
 * then makes sure a load or a save still in flight cannot put it back. Every caller has made sure
 * nothing unsaved is left, or asked the writer.
 */
async function adopt(workspaces: WorkspacesResponse): Promise<void> {
  // The hash names a document of the workspace being left; `start()` would try to reopen it.
  window.history.replaceState(null, '', '#/')
  store.set((state) => ({
    ...state,
    boot: 'loading',
    docs: {},
    current: null,
    articles: [],
    config: null,
    workspaces,
    notice: null,
    moved: null,
  }))
  resetDocSession()
  await resetJobs()
  await start()
}

const describeUnsaved = (): string | null => {
  const left = unsavedDocs()
  if (left.length === 0) return null
  const { articles } = store.get()
  return left.map((doc) => `“${docLabel(doc.ref, articles)}”`).join(', ')
}

/**
 * Save everything that is dirty, and every queued config write, and **wait for it**, then ask the
 * server to move. After the switch a save would resolve against the new root, so this order is
 * what keeps unsaved work. `flush` resolves even when the save failed (it shows a notice and
 * retries by itself), so what is still dirty afterwards is checked again: a document that could
 * not be saved stops the switch, and its text stays where it is.
 */
function move(what: string, call: () => Promise<WorkspacesResponse>): Promise<void> {
  if (store.get().moved !== null) {
    return Promise.reject(
      new Error('another tab moved the workspace; first choose what happens to the unsaved text'),
    )
  }
  return switching(what, async () => {
    await Promise.all(unsavedDocs().map((doc) => flush(doc.ref)))
    // Settings and panel toggles still on their way belong to this workspace too.
    await configWritesSettled()
    const unsaved = describeUnsaved()
    if (unsaved !== null) {
      throw new Error(
        `${unsaved} could not be saved, so the workspace was not switched; the text is still here`,
      )
    }
    await adopt(await call())
  })
}

/** One in the server's workspaces folder, by name. */
export const openWorkspace = (name: string): Promise<void> =>
  move('Opening the workspace…', () => api.openWorkspace(name))

/** One the list remembers, by id. */
export const switchWorkspace = (id: string): Promise<void> =>
  move('Opening the workspace…', () => api.switchWorkspace(id))

export const createWorkspace = (name: string): Promise<void> =>
  move('Creating the workspace…', () => api.createWorkspace(name))

/** These three change the list, never the workspace that is open, so nothing is re-loaded. */
export const renameWorkspace = async (id: string, label: string): Promise<void> =>
  remember(await api.renameWorkspace(id, label))
export const forgetWorkspace = async (id: string): Promise<void> =>
  remember(await api.forgetWorkspace(id))
export const eraseWorkspace = async (id: string, confirm: string): Promise<void> =>
  remember(await api.eraseWorkspace(id, confirm))

/** Follow the server to whatever workspace it is on now, dropping this tab's documents. */
const follow = () =>
  switching('Following the other tab…', async () => adopt(await api.workspaces()))

/**
 * The server is back on the workspace this tab shows, after a `moved` wait: its documents are
 * this tab's own again. Re-check them, the jobs and the settings against the disk, and save.
 */
async function settleBack(): Promise<void> {
  if (store.get().moved === null) return
  store.set((state) => ({ ...state, moved: null }))
  await resync()
  flushAll()
}

/**
 * The writer's first choice after `moved`: send the server back to the workspace this tab shows,
 * and save there. Any tab showing the other one follows, as it would any switch.
 */
export function returnAndSave(): Promise<void> {
  const shown = store.get().workspaces
  if (shown === null || store.get().moved === null) return Promise.resolve()
  // By path only (both sides are realpaths): labels are not unique, and a match by label could
  // send the server to another workspace and save this tab's text there.
  const entry = shown.entries.find((candidate) => candidate.path === shown.active.root)
  if (entry === undefined) {
    return Promise.reject(new Error(`“${shown.active.label}” is not in the workspace list`))
  }
  return switching('Going back and saving…', async () => {
    await api.switchWorkspace(entry.id)
    await settleBack()
  })
}

/** The writer's other choice after `moved`: drop the unsaved text here and follow. */
export const discardAndFollow = (): Promise<void> => follow()

/**
 * Another tab moved the server. This tab follows — unless it is the one switching (`switching`),
 * or it holds text that is not on disk yet. That text cannot be saved any more: a late save would
 * write the old workspace's text into the new one, and the server refuses it. So instead of
 * discarding it, the tab stays where it is and asks (`moved`).
 */
export function watchForWorkspaceChanges(): void {
  setEventHandlers({
    onWorkspaceChanged: (root, label) => {
      const state = store.get()
      if (state.switching !== null) return
      const report = (error: unknown) =>
        notifyFailure('Could not follow the workspace change', error)
      if (state.workspaces?.active.root === root) {
        // Back where this tab is, or an echo of where it already is.
        void settleBack().catch(report)
        return
      }
      if (unsavedDocs().length > 0) {
        store.set((current) => ({ ...current, moved: { root, label } }))
        return
      }
      void follow().catch(report)
    },
  })
}
