import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../../shared/events.ts'
import type { Job } from '../../shared/jobs/job-types.ts'
import type { WorkspacesResponse } from '../../shared/workspaces-schema.ts'

// The job tray across a workspace switch, at the two seams where the old workspace can reach the
// new one's tray: the event stream, and a response to a request made before the switch.
//
// The race e2e/workspace-jobs.spec.ts hit: the switching tab adopts the new workspace from the
// answer to its POST, which travels on its own connection. The old workspace's last event — its
// job marked stale by the switch — travels on the event stream and can arrive *after* that
// answer. Only the stream's own order says which workspace an event is about: the `hello` names
// one, and each `workspace.changed` moves it on.
//
// `EventSource` and `fetch` are stubbed, so the order of arrival is the test's to choose.

const A = '/workspaces/first'
const B = '/workspaces/second'

type Pending = { method: string; url: string; respond: (status: number, body: unknown) => void }
let pending: Pending[] = []

/** Let every answered request and the work it continues run to the end: no timers are faked. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The first request matching `method` and `url` that is waiting for an answer. */
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

/** The one event stream the tab opens; the test writes to it. */
class FakeEventSource {
  static last: FakeEventSource | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  private readonly listeners = new Map<string, (message: { data: string }) => void>()
  constructor() {
    FakeEventSource.last = this
  }
  addEventListener(name: string, listener: (message: { data: string }) => void): void {
    this.listeners.set(name, listener)
  }
  close(): void {}
  hello(root: string): void {
    this.listeners.get('hello')?.({ data: JSON.stringify({ root }) })
  }
  send(event: ServerEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

class MemoryStorage {
  private readonly items = new Map<string, string>()
  getItem = (key: string) => this.items.get(key) ?? null
  setItem = (key: string, value: string) => void this.items.set(key, value)
  removeItem = (key: string) => void this.items.delete(key)
}

const workspacesOf = (root: string): WorkspacesResponse => ({
  active: { root, label: root },
  home: '/workspaces',
  entries: [],
})

function job(id: string, state: Job['state'], revision: number): Job {
  return {
    id,
    doc: { kind: 'article', slug: 'hello' },
    scope: 'blocks',
    instruction: `instruction ${id}`,
    skill: null,
    adapter: 'fake',
    state,
    reason: null,
    error: null,
    targets: ['b1'],
    owner: null,
    snapshotRaws: {},
    result: null,
    rawOutput: null,
    decisions: {},
    progress: [],
    revision,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  }
}

beforeEach(() => {
  vi.resetModules()
  pending = []
  FakeEventSource.last = null
  vi.stubGlobal('window', {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: number | undefined) => clearTimeout(id),
    history: { replaceState: () => {} },
    location: { hash: '' },
    addEventListener: () => {},
    sessionStorage: new MemoryStorage(),
  })
  vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' })
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    (url: string, init?: { method?: string }) =>
      new Promise<Response>((resolve) => {
        pending.push({
          method: init?.method ?? 'GET',
          url,
          respond: (status, body) => resolve(new Response(JSON.stringify(body), { status })),
        })
      }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A tab on workspace A with its event stream connected and its first sync answered: what every
 * test starts from. The reconnect check's other reads are answered with nothing.
 */
async function connected() {
  const app = await import('./app.ts')
  const jobs = await import('./jobs.ts')
  const tab = await import('./tab.ts')
  app.store.set((state) => ({ ...state, workspaces: workspacesOf(A) }))
  tab.acceptRestore(A)
  jobs.startJobs()
  app.connectEvents()
  const stream = FakeEventSource.last
  if (stream === null) throw new Error('no event stream')
  stream.hello(A)
  ;(await take('GET', '/api/workspaces')).respond(200, workspacesOf(A))
  ;(await take('GET', '/api/jobs')).respond(200, { jobs: [], tabs: [] })
  ;(await take('GET', '/api/config')).respond(200, { config: {}, error: null })
  ;(await take('GET', '/api/articles')).respond(200, { articles: [] })
  ;(await take('GET', '/api/skills')).respond(200, { skills: [], errors: [] })
  /** The job ids in the tray, in order. */
  const tray = () => jobs.jobsState().order
  /** What `adopt` does to the jobs when the answer to a switch arrives: show B, reload its jobs. */
  const adoptB = async (bJobs: Job[] = []) => {
    app.store.set((state) => ({ ...state, workspaces: workspacesOf(B) }))
    const reset = jobs.resetJobs()
    ;(await take('GET', '/api/jobs')).respond(200, { jobs: bJobs, tabs: [] })
    await reset
  }
  return { app, jobs, stream, tray, adoptB }
}

describe('the event stream across a switch', () => {
  it("drops the old workspace's last event when it arrives after the switch's answer", async () => {
    const { stream, tray, adoptB } = await connected()
    stream.send({ type: 'job.state', job: job('old', 'running', 2) })
    expect(tray()).toEqual(['old'])

    // The answer to this tab's switch lands first; the stream is still reporting on A.
    await adoptB()
    expect(tray()).toEqual([])
    stream.send({ type: 'job.state', job: job('old', 'stale', 3) })
    stream.send({ type: 'job.progress', id: 'old', text: 'still going' })
    expect(tray()).toEqual([])

    // The stream reaches the switch: from here on it reports on B, and B's jobs show.
    stream.send({ type: 'workspace.changed', root: B, label: 'second' })
    stream.send({ type: 'job.state', job: job('new', 'queued', 1) })
    expect(tray()).toEqual(['new'])
  })

  it("does not reload a document for the old workspace's late doc.changed", async () => {
    const { stream, adoptB } = await connected()
    await adoptB()
    stream.send({ type: 'doc.changed', ref: { kind: 'article', slug: 'hello' }, hash: 'h-old' })
    stream.send({ type: 'config.changed' })
    stream.send({ type: 'skills.changed' })
    await settle()
    expect(pending.map((request) => `${request.method} ${request.url}`)).toEqual([])
  })

  it('reads the workspace a (re)connected stream is about from its hello', async () => {
    const { app, stream, tray } = await connected()
    // The stream reconnects after another tab moved the server to B; this tab still shows A.
    stream.hello(B)
    stream.send({ type: 'job.state', job: job('of-b', 'queued', 1) })
    expect(tray()).toEqual([])
    // Once the tab shows B, the same stream's events are its own.
    app.store.set((state) => ({ ...state, workspaces: workspacesOf(B) }))
    stream.send({ type: 'job.state', job: job('of-b', 'running', 2) })
    expect(tray()).toEqual(['of-b'])
  })
})

describe('responses to requests made before a switch', () => {
  it("drops a sync that read the old workspace's jobs and answers after the switch", async () => {
    const { app, stream, tray, adoptB } = await connected()
    // A reconnect's sync, still on its way when the switch comes.
    stream.hello(A)
    ;(await take('GET', '/api/workspaces')).respond(200, workspacesOf(A))
    const oldSync = await take('GET', '/api/jobs')

    await adoptB()
    // Settled, so it would go straight into the tray: nothing about it needs asking.
    oldSync.respond(200, { jobs: [job('old', 'settled', 2)], tabs: [] })
    await settle()
    expect(tray()).toEqual([])
    expect(app.store.get().workspaces?.active.root).toBe(B)
  })

  it("drops a reconnect's article list and settings read from the old workspace", async () => {
    const { app, stream, adoptB } = await connected()
    stream.hello(A)
    ;(await take('GET', '/api/workspaces')).respond(200, workspacesOf(A))
    await take('GET', '/api/jobs')
    const oldArticles = await take('GET', '/api/articles')
    const oldConfig = await take('GET', '/api/config')

    app.resetDocSession()
    await adoptB()
    oldArticles.respond(200, { articles: [{ slug: 'old-article', title: 'Of the first' }] })
    oldConfig.respond(200, { config: {}, error: 'invalid in the first workspace' })
    await settle()
    expect(app.store.get().articles).toEqual([])
    expect(app.store.get().config?.error ?? null).toBeNull()
  })

  it('drops a cancel of an old job whose answer comes after the switch', async () => {
    const { jobs, stream, tray, adoptB } = await connected()
    stream.send({ type: 'job.state', job: job('old', 'running', 2) })
    const cancelling = jobs.cancelJob('old')
    const cancel = await take('POST', '/api/jobs/old/cancel')

    await adoptB()
    cancel.respond(200, job('old', 'cancelled', 3))
    await cancelling
    expect(tray()).toEqual([])
  })

  it("still takes the current workspace's answers", async () => {
    // The control: the fence drops only what belongs to the workspace that was left.
    const { jobs, stream, tray } = await connected()
    stream.send({ type: 'job.state', job: job('here', 'running', 2) })
    const cancelling = jobs.cancelJob('here')
    ;(await take('POST', '/api/jobs/here/cancel')).respond(200, job('here', 'cancelled', 3))
    await cancelling
    expect(tray()).toEqual(['here'])
    expect(jobs.jobsState().jobs.here?.state).toBe('cancelled')
  })
})
