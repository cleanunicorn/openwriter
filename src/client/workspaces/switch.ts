import type { WorkspacesResponse } from '../../shared/workspaces-schema.ts'
import { api } from '../api.ts'
import {
  configWritesSettled,
  flush,
  notifyFailure,
  resetDocSession,
  setEventHandlers,
  start,
  store,
} from '../state/app.ts'
import { isDirty } from '../state/doc-reducer.ts'
import { resetJobs } from '../state/jobs.ts'

const remember = (workspaces: WorkspacesResponse) =>
  store.set((state) => ({ ...state, workspaces }))

/**
 * Move the editor to the workspace the server has just opened.
 *
 * The document state is thrown away rather than reconciled: `resync()` compares every open
 * document with what is on disk, so one left in the store would be read as an *outside change*
 * to the new workspace's article of the same slug — the confusion AC2 forbids. `resetDocSession`
 * then makes sure a load or a save still in flight cannot put it back.
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
  }))
  resetDocSession()
  await resetJobs()
  await start()
}

/**
 * Save everything that is dirty, and every queued config write, and **wait for it**, then ask the
 * server to move. After the
 * switch a save would resolve against the new root, so this order is what keeps unsaved work.
 * `flush` is the one that returns a promise; `flushAll` fires the saves and returns void, which
 * is nothing to wait for.
 */
async function move(call: () => Promise<WorkspacesResponse>): Promise<void> {
  const dirty = Object.values(store.get().docs).filter(isDirty)
  await Promise.all(dirty.map((doc) => flush(doc.ref)))
  // Settings and panel toggles still on their way belong to this workspace too.
  await configWritesSettled()
  await adopt(await call())
}

/** One in the server's workspaces folder, by name. */
export const openWorkspace = (name: string): Promise<void> => move(() => api.openWorkspace(name))

/** One the list remembers, by id. */
export const switchWorkspace = (id: string): Promise<void> => move(() => api.switchWorkspace(id))

export const createWorkspace = (name: string): Promise<void> =>
  move(() => api.createWorkspace(name))

/** These three change the list, never the workspace that is open, so nothing is re-loaded. */
export const renameWorkspace = async (id: string, label: string): Promise<void> =>
  remember(await api.renameWorkspace(id, label))
export const forgetWorkspace = async (id: string): Promise<void> =>
  remember(await api.forgetWorkspace(id))
export const eraseWorkspace = async (id: string, confirm: string): Promise<void> =>
  remember(await api.eraseWorkspace(id, confirm))

/**
 * Another tab moved the server. This tab follows — unless it is the tab that asked, whose store
 * already names the root the event carries.
 */
export function watchForWorkspaceChanges(): void {
  setEventHandlers({
    onWorkspaceChanged: (root) => {
      if (store.get().workspaces?.active.root === root) return
      void api
        .workspaces()
        .then(adopt)
        .catch((error: unknown) => notifyFailure('Could not follow the workspace change', error))
    },
  })
}
