import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocRef } from '../../shared/api-types.ts'
import { type DocState, liveText } from './doc-reducer.ts'

// `resetDocSession` fencing. A workspace switch clears `docs` and resets the document session in
// one breath (`adopt` in src/client/workspaces/switch.ts); these tests stand in for it with the
// same two calls. Document state is keyed by `DocRef`, which says nothing about the workspace, so
// the one case that matters is the new workspace opening the *same* ref while a response of the
// old one is still on its way: without the fence that response lands in the new document.
//
// `fetch` is the seam, not `api`: every request goes through the real `api.ts`, and each one waits
// until the test answers it, so the order of arrival is the test's to choose, never a race.

type Pending = {
  method: string
  url: string
  body: unknown
  respond: (status: number, body: unknown) => void
}

const ref: DocRef = { kind: 'article', slug: 'hello' }
const URL = '/api/docs/article/hello'
const OLD = '# Hello\n\nThe old workspace.\n'
const NEW = '# Hello\n\nThe new workspace.\n'

let pending: Pending[] = []

/** The first request matching `method` and `url` that is waiting for an answer; fails if none. */
async function take(method: string, url: string): Promise<Pending> {
  let found: Pending | undefined
  await vi.waitFor(() => {
    found = pending.find((request) => request.method === method && request.url === url)
    if (found === undefined) throw new Error(`no ${method} ${url} waiting`)
  })
  if (found === undefined) throw new Error('unreachable')
  pending = pending.filter((request) => request !== found)
  return found
}

/** The part of `Storage` that state/tab.ts uses, in memory. */
class MemoryStorage {
  private readonly items = new Map<string, string>()
  getItem = (key: string) => this.items.get(key) ?? null
  setItem = (key: string, value: string) => void this.items.set(key, value)
  removeItem = (key: string) => void this.items.delete(key)
}

/** What the writer sees, draft included. */
const textOf = (doc: DocState | undefined) => (doc === undefined ? undefined : liveText(doc))

/** Let every settled promise run its continuations. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  pending = []
  vi.stubGlobal('window', {
    // Looked up at call time, so the fake timers installed above are the ones used.
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: number | undefined) => clearTimeout(id),
    history: { replaceState: () => {} },
    location: { hash: '' },
    addEventListener: () => {},
    // Empty, as in a fresh tab: no session from before a reload (state/tab.ts) is restored.
    sessionStorage: new MemoryStorage(),
  })
  vi.stubGlobal(
    'fetch',
    (url: string, init?: { method?: string; body?: string }) =>
      new Promise<Response>((resolve) => {
        pending.push({
          method: init?.method ?? 'GET',
          url,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
          respond: (status, body) => resolve(new Response(JSON.stringify(body), { status })),
        })
      }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A fresh copy of the module state: every test starts with no documents and session 0. */
async function load() {
  const app = await import('./app.ts')
  /** What `adopt` does to the document state when the editor moves to another workspace. */
  const switchWorkspace = () => {
    app.store.set((state) => ({ ...state, docs: {}, current: null }))
    app.resetDocSession()
  }
  /** Open `ref` and answer its read with `text`: a ready document. */
  const openWith = async (text: string, hash: string) => {
    const opened = app.openDoc(ref)
    ;(await take('GET', URL)).respond(200, { text, hash, exists: true })
    await opened
    const doc = app.docStateOf(ref)
    expect(doc?.status).toBe('ready')
    return doc
  }
  /** Type into the first block, so the document is ahead of the disk. */
  const edit = (text: string) => {
    const id = app.docStateOf(ref)?.doc.blocks[0]?.id
    if (id === undefined) throw new Error('no block')
    app.dispatchDoc(ref, { type: 'focus', id, cursor: 'end' })
    app.dispatchDoc(ref, { type: 'draft', id, text })
  }
  return { app, switchWorkspace, openWith, edit }
}

describe('resetDocSession fencing', () => {
  it("drops a load that answers after the switch, so the new workspace's document stays its own", async () => {
    const { app, switchWorkspace } = await load()
    void app.openDoc(ref)
    const oldRead = await take('GET', URL)

    switchWorkspace()
    const opened = app.openDoc(ref)
    ;(await take('GET', URL)).respond(200, { text: NEW, hash: 'h-new', exists: true })
    await opened

    // The old workspace's read arrives last, as a slow disk or a slow network would make it.
    oldRead.respond(200, { text: OLD, hash: 'h-old', exists: true })
    await settle()

    const doc = app.docStateOf(ref)
    expect(doc?.savedText).toBe(NEW)
    expect(doc?.baseHash).toBe('h-new')
  })

  it('drops a failed load of the old workspace instead of marking the new document failed', async () => {
    const { app, switchWorkspace, openWith } = await load()
    void app.openDoc(ref)
    const oldRead = await take('GET', URL)

    switchWorkspace()
    await openWith(NEW, 'h-new')
    oldRead.respond(500, { error: 'disk on fire' })
    await settle()

    expect(app.docStateOf(ref)?.status).toBe('ready')
    expect(app.docStateOf(ref)?.error).toBeNull()
  })

  it('drops a save that succeeds after the switch, even when both files had the same hash', async () => {
    // Two workspaces made from the same template hold byte-identical files, so the reducer's own
    // guard (`saved` ignores a base hash that moved on) cannot tell them apart: only the session
    // can. Unfenced, the new document would record the old text as saved at the old save's hash,
    // and its next save would be refused as a conflict.
    const { app, switchWorkspace, openWith, edit } = await load()
    await openWith(NEW, 'h-same')
    edit('# Hello, typed in the old workspace')
    const saving = app.flush(ref)
    const oldSave = await take('PUT', URL)

    switchWorkspace()
    await openWith(NEW, 'h-same')
    oldSave.respond(200, { hash: 'h-old-saved' })
    await saving

    const doc = app.docStateOf(ref)
    expect(doc?.baseHash).toBe('h-same')
    expect(doc?.savedText).toBe(NEW)
    expect(app.unsavedDocs()).toEqual([])
  })

  it("drops a save refused as a conflict after the switch: the old file's text is not merged in", async () => {
    const { app, switchWorkspace, openWith, edit } = await load()
    await openWith(OLD, 'h-old')
    edit('# Hello, typed in the old workspace')
    const saving = app.flush(ref)
    const oldSave = await take('PUT', URL)

    switchWorkspace()
    await openWith(NEW, 'h-new')
    // Unfenced, this is reconciled as an outside change: the old workspace's file in the new document.
    oldSave.respond(409, {
      text: `${OLD}\nChanged on disk in the old workspace.\n`,
      hash: 'h-x',
      exists: true,
    })
    await saving

    const doc = app.docStateOf(ref)
    expect(doc?.baseHash).toBe('h-new')
    expect(textOf(doc)).toBe(NEW)
  })

  it('drops a save that fails after the switch: no notice on the new document, no retry', async () => {
    const { app, switchWorkspace, openWith, edit } = await load()
    await openWith(OLD, 'h-old')
    edit('# Hello, typed in the old workspace')
    const saving = app.flush(ref)
    const oldSave = await take('PUT', URL)

    switchWorkspace()
    await openWith(NEW, 'h-new')
    oldSave.respond(500, { error: 'disk full' })
    await saving
    // Well past the retry a failed save schedules for itself.
    await vi.advanceTimersByTimeAsync(10_000)

    expect(app.docStateOf(ref)?.notice).toBeNull()
    expect(pending.filter((request) => request.method === 'PUT')).toEqual([])
  })

  it('cancels an autosave that was only scheduled when the switch came', async () => {
    const { switchWorkspace, openWith, edit } = await load()
    await openWith(OLD, 'h-old')
    edit('# Hello, typed in the old workspace')

    switchWorkspace()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(pending.filter((request) => request.method === 'PUT')).toEqual([])
  })

  it('drops a reconnect check that reads the old disk after the switch', async () => {
    const { app, switchWorkspace, openWith } = await load()
    await openWith(OLD, 'h-old')
    const checking = app.resync()
    const oldRead = await take('GET', URL)

    switchWorkspace()
    await openWith(NEW, 'h-new')
    oldRead.respond(200, { text: OLD, hash: 'h-old-2', exists: true })
    // The rest of the reconnect: settings, articles, skills.
    ;(await take('GET', '/api/config')).respond(200, {
      config: {},
      error: null,
    })
    ;(await take('GET', '/api/articles')).respond(200, { articles: [] })
    ;(await take('GET', '/api/skills')).respond(200, { skills: [], errors: [] })
    await checking.catch(() => undefined)

    const doc = app.docStateOf(ref)
    expect(doc?.baseHash).toBe('h-new')
    expect(textOf(doc)).toBe(NEW)
  })

  it('still lets a response of the current session through', async () => {
    // The control: the fence drops only what belongs to the session that was left.
    const { app, openWith, edit } = await load()
    await openWith(OLD, 'h-old')
    edit('# Hello, typed here')
    const saving = app.flush(ref)
    ;(await take('PUT', URL)).respond(200, { hash: 'h-saved' })
    await saving

    expect(app.docStateOf(ref)?.baseHash).toBe('h-saved')
    expect(app.unsavedDocs()).toEqual([])
  })
})
