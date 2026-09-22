import {
  type Article,
  type ConfigResponse,
  type DocRef,
  DocResponseSchema,
  docKey,
  type SkillInfo,
  type SkillProblem,
} from '../../shared/api-types.ts'
import type { Config } from '../../shared/config-schema.ts'
import type { WorkspacesResponse } from '../../shared/workspaces-schema.ts'
import { type ServerEvent, ServerEventSchema } from '../../shared/events.ts'
import { isSlug } from '../../shared/names.ts'
import { ApiError, api, nameWorkspaceWith, workspaceMoved } from '../api.ts'
import {
  type DocAction,
  type DocState,
  docReducer,
  initialDocState,
  isDirty,
  liveText,
} from './doc-reducer.ts'
import { acceptRestore, restoredRefs, tabId, takeRestoredDoc } from './tab.ts'
import { createStore, useStoreSlice } from './store.ts'

export type PaletteMode =
  | { kind: 'commands' }
  | { kind: 'input'; label: string; placeholder: string; submit: (value: string) => void }
  /**
   * Like `input`, but Enter does nothing until what was typed is exactly `phrase`. `warning` is
   * shown under the input for as long as the prompt is open: a placeholder vanishes at the first
   * keystroke, which is exactly when the writer needs to still see what they are about to do.
   */
  | {
      kind: 'confirm'
      label: string
      placeholder: string
      warning: string
      phrase: string
      submit: () => void
    }

export type Panel = 'settings' | null

export type AppState = {
  /** The first load: loading, ready, or why it failed. Empty and failed must not look alike. */
  boot: 'loading' | 'ready' | { error: string }
  current: DocRef | null
  /** Every document opened this session keeps its IDs, history, and jobs across switches. */
  docs: Record<string, DocState>
  articles: Article[]
  config: ConfigResponse | null
  /**
   * Prompt templates from `skills/` and the workspace's `.zen/skills/`; the palette lists them,
   * the editor knows nothing else.
   */
  skills: SkillInfo[]
  /** Workspace skill files that did not load, and why; the palette and the agent panel show them. */
  skillErrors: SkillProblem[]
  /** The open workspace and the ones the writer has opened before; the palette lists them. */
  workspaces: WorkspacesResponse | null
  /**
   * A failure with no document to show it on: an empty workspace has none, and the workspace
   * commands are reachable from there. With a document open, its own notice is used instead.
   */
  notice: string | null
  /** A workspace switch this tab is making, and what to call it; the document waits meanwhile. */
  switching: string | null
  /**
   * Another tab moved the server to this workspace while this one held unsaved text. The tab stays
   * on the workspace it shows, with autosave paused and every event of the new one ignored, until
   * the writer chooses: go back and save, or discard and follow.
   */
  moved: { root: string; label: string } | null
  palette: PaletteMode | null
  panel: Panel
  /** Bumped whenever the effective theme changes, so baked-in colours (diagrams) re-render. */
  themeEpoch: number
}

export const store = createStore<AppState>({
  boot: 'loading',
  current: null,
  docs: {},
  articles: [],
  config: null,
  skills: [],
  skillErrors: [],
  workspaces: null,
  notice: null,
  switching: null,
  moved: null,
  palette: null,
  panel: null,
  themeEpoch: 0,
})

// Every request names the workspace on screen; see `nameWorkspaceWith`.
nameWorkspaceWith(() => store.get().workspaces?.active.root)

export const useApp = <T>(selector: (state: AppState) => T): T => useStoreSlice(store, selector)

export const currentDoc = (state: AppState): DocState | null =>
  state.current === null ? null : (state.docs[docKey(state.current)] ?? null)

/** The state of one open document, by ref; `currentDoc` is the selector for the one on screen. */
export const docStateOf = (ref: DocRef): DocState | undefined => store.get().docs[docKey(ref)]

export function dispatchDoc(ref: DocRef, action: DocAction): void {
  const key = docKey(ref)
  store.set((state) => {
    const doc = state.docs[key]
    if (doc === undefined) return state
    const next = docReducer(doc, action)
    return next === doc ? state : { ...state, docs: { ...state.docs, [key]: next } }
  })
}

/**
 * Tell the writer that a background action failed. Every fire-and-forget action ends here instead
 * of in an unhandled rejection that nobody sees.
 */
export function notifyFailure(
  what: string,
  error: unknown,
  ref: DocRef | null = store.get().current,
): void {
  const message = `${what}: ${error instanceof Error ? error.message : String(error)}`
  if (ref !== null && docStateOf(ref) !== undefined)
    dispatchDoc(ref, { type: 'notice', notice: message })
  else setNotice(message)
}

/** Show (or, with null, dismiss) the notice that belongs to no document. */
export const setNotice = (notice: string | null) => store.set((state) => ({ ...state, notice }))

/** Dispatch to the document on screen. */
export function dispatch(action: DocAction): void {
  const ref = store.get().current
  if (ref !== null) dispatchDoc(ref, action)
}

// ── saving ────────────────────────────────────────────────────────────────────────────────

const AUTOSAVE_MS = 750
const SAVE_RETRY_MS = 3000
const timers = new Map<string, number>()
const lastSeen = new Map<string, string>()
const inFlight = new Map<string, Promise<void>>()

/**
 * Which set of documents the editor is looking at. Document state is keyed by `DocRef`, which
 * says nothing about the workspace, so a load or a save that was already in flight when the
 * editor moved to another workspace would otherwise land in the new one's state — the same
 * slug, a different article.
 */
let docSession = 0

/**
 * Forget the document session: every response still in flight belongs to the workspace that is
 * no longer open and is dropped when it arrives. Called by the workspace switch, which clears
 * `docs` in the same breath.
 */
export function resetDocSession(): void {
  docSession++
  for (const timer of timers.values()) window.clearTimeout(timer)
  timers.clear()
  lastSeen.clear()
  inFlight.clear()
}

async function save(ref: DocRef): Promise<void> {
  const key = docKey(ref)
  const state = store.get().docs[key]
  if (state === undefined || !isDirty(state)) return
  // The server is on another workspace now; nothing here may be saved there (see `moved`).
  if (store.get().moved !== null) return
  const text = liveText(state)
  const session = docSession
  try {
    const base = state.baseHash
    const { hash } = await api.save(ref, text, base)
    if (session !== docSession) return
    dispatchDoc(ref, { type: 'saved', text, hash, baseHash: base })
  } catch (error) {
    if (session !== docSession) return
    if (workspaceMoved(error)) {
      // Refused, not lost: the text stays dirty in this tab, which now learns of the switch.
      void followServer().catch((reason: unknown) =>
        notifyFailure('Could not follow the workspace change', reason, ref),
      )
      return
    }
    const disk =
      error instanceof ApiError && error.status === 409
        ? DocResponseSchema.safeParse(error.body)
        : null
    if (disk?.success === true) {
      // Someone else changed (or deleted) the file: reconcile instead of overwriting.
      const { text, hash, exists } = disk.data
      dispatchDoc(ref, { type: 'external', text, hash, exists })
      return
    }
    dispatchDoc(ref, { type: 'notice', notice: `Could not save: ${(error as Error).message}` })
    // Try again by itself: the debounce only fires on a text change, and the writer may stop typing.
    window.clearTimeout(timers.get(key))
    timers.set(
      key,
      window.setTimeout(() => void flush(ref), SAVE_RETRY_MS),
    )
  }
}

/** Save now (and wait for it). Used before a job starts, before switching, before export. */
export function flush(ref: DocRef): Promise<void> {
  const key = docKey(ref)
  window.clearTimeout(timers.get(key))
  const chained = (inFlight.get(key) ?? Promise.resolve()).then(() => save(ref))
  inFlight.set(key, chained)
  return chained
}

// Debounced autosave: only when the text really differs from what is on disk.
store.subscribe(() => {
  for (const [key, doc] of Object.entries(store.get().docs)) {
    if (!isDirty(doc)) continue
    // Keyed by the revision as well as the text: a reload can restore the editor's block and
    // leave the live text exactly as it was last saved, while the disk — now a revision on —
    // no longer holds it. Text alone called that a repeat and the writer's block stayed unsaved
    // until they typed again.
    const text = liveText(doc)
    const seen = `${doc.baseHash ?? ''}\u0000${text}`
    if (lastSeen.get(key) === seen) continue
    lastSeen.set(key, seen)
    window.clearTimeout(timers.get(key))
    timers.set(
      key,
      window.setTimeout(() => void flush(doc.ref), AUTOSAVE_MS),
    )
  }
})

/** The open documents that are ahead of the disk. */
export const unsavedDocs = (): DocState[] => Object.values(store.get().docs).filter(isDirty)

/** Is any open document ahead of the disk? Used by the unload guard. */
export const hasUnsavedChanges = (): boolean => unsavedDocs().length > 0

/** Save everything that is dirty, now. The tab going to the background is the last safe moment. */
export function flushAll(): void {
  for (const doc of Object.values(store.get().docs)) if (isDirty(doc)) void flush(doc.ref)
}

// ── loading and navigation ────────────────────────────────────────────────────────────────

const refToHash = (ref: DocRef): string =>
  ref.kind === 'strategy' ? '#/strategy' : `#/${ref.kind}/${ref.slug}`

function hashToRef(hash: string): DocRef | null {
  const [, kind, slug] = hash.split('/')
  if (kind === 'strategy') return { kind }
  if ((kind === 'article' || kind === 'brief') && slug !== undefined && isSlug(slug)) {
    return { kind, slug }
  }
  return null
}

async function load(ref: DocRef): Promise<void> {
  const session = docSession
  try {
    const doc = await api.doc(ref)
    if (session !== docSession) return
    // The first load after a page reload puts the blocks' IDs back (state/session.ts).
    const restore = takeRestoredDoc(ref)
    dispatchDoc(ref, { type: 'loaded', ...doc, ...(restore === undefined ? {} : { restore }) })
  } catch (error) {
    if (session !== docSession) return
    dispatchDoc(ref, { type: 'failed', error: (error as Error).message })
    if (workspaceMoved(error)) {
      void followServer().catch((reason: unknown) =>
        notifyFailure('Could not follow the workspace change', reason, ref),
      )
    }
  }
}

export async function openDoc(ref: DocRef): Promise<void> {
  const previous = store.get().current
  if (previous !== null && docKey(previous) !== docKey(ref)) {
    dispatchDoc(previous, { type: 'blur' })
    void flush(previous)
  }
  const key = docKey(ref)
  const known = store.get().docs[key] !== undefined
  store.set((state) => ({
    ...state,
    current: ref,
    docs: known ? state.docs : { ...state.docs, [key]: initialDocState(ref) },
  }))
  if (window.location.hash !== refToHash(ref)) window.history.replaceState(null, '', refToHash(ref))
  if (!known) await load(ref)
}

/**
 * Load a document without putting it on screen: one that was open before a page reload, so its
 * blocks get their IDs back before a job or a held request about it needs them.
 */
function preload(ref: DocRef): void {
  const key = docKey(ref)
  if (store.get().docs[key] !== undefined) return
  store.set((state) => ({ ...state, docs: { ...state.docs, [key]: initialDocState(ref) } }))
  void load(ref)
}

export async function refreshArticles(): Promise<void> {
  const { articles } = await api.articles()
  store.set((state) => ({ ...state, articles }))
}

export async function refreshWorkspaces(): Promise<void> {
  const workspaces = await api.workspaces()
  store.set((state) => ({ ...state, workspaces }))
}

/** The quick toggles `saveConfigPatch` owns; Settings saves the rest through `saveSettings`. */
type ConfigPatch = Partial<Pick<Config, 'theme' | 'ui'>>

/**
 * Every write of `.zen/config.json` from this page goes through one queue, so two writes can never
 * land on disk in the wrong order: the server replaces the whole file on each PUT. Each write
 * builds its body when its turn comes, from the state at that moment.
 */
let configWrites: Promise<unknown> = Promise.resolve()
let configSavesInFlight = 0
/** A quick-toggle write is waiting in the queue; it will send the latest state, so one is enough. */
let quickWriteQueued = false

function queueConfigWrite<T>(write: () => Promise<T>): Promise<T> {
  configSavesInFlight += 1
  const next = configWrites.then(async () => {
    try {
      return await write()
    } finally {
      configSavesInFlight -= 1
    }
  })
  configWrites = next.catch(() => undefined)
  return next
}

/** Resolves once every config write queued so far has been answered. A switch waits for this. */
export const configWritesSettled = (): Promise<void> => configWrites.then(() => undefined)

/**
 * The workspace a write is for. It loads alongside the config at start, so a write made before it
 * has arrived asks for it: no write leaves this page without saying which workspace it is for.
 */
async function workspaceRoot(): Promise<string> {
  const known = store.get().workspaces
  if (known !== null) return known.active.root
  const workspaces = await api.workspaces()
  store.set((state) => (state.workspaces === null ? { ...state, workspaces } : state))
  return workspaces.active.root
}

/** A write refused because another workspace is open now: show the settings really in force. */
const reloadIfRefused = (error: unknown) => {
  if (error instanceof ApiError && error.status === 409) void refreshConfig()
}

/**
 * The writer for quick toggles (theme, panels). The store changes first, so the next toggle sees
 * this one; the write is queued behind any other, and toggles made while one waits share it. While
 * any write is queued, `refreshConfig` keeps the local theme and panels, so an older copy fetched
 * in between can never flip them back. An invalid config file is never overwritten: the toggle
 * then holds for this session only.
 */
export async function saveConfigPatch(patch: ConfigPatch, what: string): Promise<void> {
  const current = store.get().config
  if (current === null) return
  store.set((state) =>
    state.config === null
      ? state
      : { ...state, config: { ...state.config, config: { ...state.config.config, ...patch } } },
  )
  if (current.error !== null || quickWriteQueued) return
  quickWriteQueued = true
  await queueConfigWrite(async () => {
    quickWriteQueued = false
    try {
      const root = await workspaceRoot()
      const latest = store.get().config
      if (latest === null || latest.error !== null) return
      await api.saveConfig(latest.config, root)
    } catch (error) {
      notifyFailure(what, error)
      reloadIfRefused(error)
    }
  })
}

/**
 * The Settings form's save, in the same queue. The panels are toggles, not form fields: the write
 * keeps whatever they are when its turn comes. The store takes the saved file at once, so a toggle
 * queued behind this save sends the new settings rather than the ones from before the form.
 */
export function saveSettings(draft: Config): Promise<void> {
  return queueConfigWrite(async () => {
    const root = await workspaceRoot()
    const ui = store.get().config?.config.ui ?? draft.ui
    const saved = await api.saveConfig({ ...draft, ui }, root).catch((error: unknown) => {
      reloadIfRefused(error)
      throw error
    })
    store.set((state) => ({
      ...state,
      config: { ...saved, config: { ...saved.config, ui: state.config?.config.ui ?? ui } },
    }))
  })
}

export async function refreshConfig(): Promise<void> {
  const config = await api.config()
  store.set((state) => {
    const local = state.config?.config
    // While a toggle is still on its way to disk, the server's copy is older than the screen.
    if (configSavesInFlight === 0 || local === undefined || config.error !== null)
      return { ...state, config }
    return {
      ...state,
      config: { ...config, config: { ...config.config, theme: local.theme, ui: local.ui } },
    }
  })
}

async function refreshSkills(): Promise<void> {
  const { skills, errors } = await api.skills()
  store.set((state) => ({ ...state, skills, skillErrors: errors }))
  announceSkillErrors()
}

/** The skill problems the writer has already been told about in a notice, this session. */
const announcedSkillErrors = new Set<string>()
const skillErrorKey = (problem: SkillProblem) => `${problem.file}\0${problem.error}`

/** One line for a skill file that did not load: where it is and what to fix. */
export const describeSkillError = (problem: SkillProblem) =>
  `Skill not loaded: ${problem.file} — ${problem.error}`

/**
 * Tell the writer, once, about each workspace skill file that did not load. The palette and the
 * agent panel keep listing them; the notice makes sure a file just saved with a mistake is seen.
 * Without a document on screen there is nowhere to say it yet: `start` calls this again.
 */
function announceSkillErrors(): void {
  const { current, skillErrors } = store.get()
  if (current === null || docStateOf(current) === undefined) return
  const fresh = skillErrors.filter((problem) => !announcedSkillErrors.has(skillErrorKey(problem)))
  if (fresh.length === 0) return
  for (const problem of fresh) announcedSkillErrors.add(skillErrorKey(problem))
  const [first] = fresh
  const notice =
    fresh.length === 1 && first !== undefined
      ? describeSkillError(first)
      : `${fresh.length} workspace skills did not load: ${fresh.map((p) => p.file).join(', ')}. The agent panel says why.`
  dispatchDoc(current, { type: 'notice', notice })
}

export async function createArticle(title: string): Promise<void> {
  try {
    const article = await api.createArticle(title)
    await refreshArticles()
    await openDoc({ kind: 'article', slug: article.slug })
  } catch (error) {
    notifyFailure('Could not create the article', error)
  }
}

export const bumpThemeEpoch = () =>
  store.set((state) => ({ ...state, themeEpoch: state.themeEpoch + 1 }))
export const setPalette = (palette: PaletteMode | null) =>
  store.set((state) => ({ ...state, palette }))
export const setPanel = (panel: Panel) => store.set((state) => ({ ...state, panel }))

// ── server events ─────────────────────────────────────────────────────────────────────────

type EventHandlers = {
  onJobEvent?: (event: ServerEvent) => void
  onConnect?: () => void
  /**
   * The server is on `root`, which may not be the workspace this tab shows: another tab moved it,
   * or moved it back. Also called when a reconnect or a refused request finds that out.
   */
  onWorkspaceChanged?: (root: string, label: string) => void
}
const handlers: EventHandlers = {}
export const setEventHandlers = (next: EventHandlers) => Object.assign(handlers, next)

async function onDocChanged(ref: DocRef, hash: string | null): Promise<void> {
  const state = docStateOf(ref)
  if (state === undefined || state.baseHash === hash) return
  const session = docSession
  try {
    const disk = await api.doc(ref)
    if (session !== docSession) return
    dispatchDoc(ref, { type: 'external', ...disk })
  } catch (error) {
    if (session !== docSession) return
    dispatchDoc(ref, { type: 'notice', notice: `Could not reload: ${(error as Error).message}` })
  }
}

/**
 * Ask the server which workspace is open, and hand it to `onWorkspaceChanged` when it is not the
 * one this tab shows — or when this tab is waiting on a `moved` decision, which it may settle.
 * True when it did. Before the tab knows its workspace there is nothing to compare.
 */
export async function followServer(): Promise<boolean> {
  const known = store.get().workspaces?.active.root
  if (known === undefined) return false
  const { active } = await api.workspaces()
  if (active.root === known && store.get().moved === null) return false
  handlers.onWorkspaceChanged?.(active.root, active.label)
  return true
}

/**
 * The server keeps no event log, so whatever happened while the stream was down is unknown:
 * on every (re)connect first check that the server is still on this tab's workspace — a switch
 * made meanwhile from another tab would otherwise make the other workspace's same-slug article
 * look like an outside change to this one — then re-check each open document against the disk
 * (through the same reconcile as a live event, so a focused draft survives), the jobs, the
 * settings, and the article list.
 */
export async function resync(): Promise<void> {
  if (await followServer()) return
  handlers.onConnect?.()
  const open = Object.values(store.get().docs).filter((doc) => doc.status === 'ready')
  await Promise.all([
    ...open.map(async (doc) => {
      const session = docSession
      try {
        const disk = await api.doc(doc.ref)
        if (session !== docSession) return
        if (disk.hash !== docStateOf(doc.ref)?.baseHash) {
          dispatchDoc(doc.ref, { type: 'external', ...disk })
        }
      } catch (error) {
        // A switch landed between the check above and this read: follow it, compare nothing.
        if (!workspaceMoved(error)) throw error
        await followServer()
      }
    }),
    refreshConfig(),
    refreshArticles(),
    refreshSkills(),
  ])
}

export function connectEvents(): () => void {
  // The stream says which tab it is: the server lists the tabs that are open, and another tab
  // leaves this one's jobs alone while it is (state/jobs.ts, `sync`).
  const source = new EventSource(`/api/events?tab=${encodeURIComponent(tabId)}`)
  source.addEventListener('hello', () => {
    void resync().catch((error: unknown) =>
      notifyFailure('Could not check for outside changes', error),
    )
  })
  source.onmessage = (message) => {
    const parsed = ServerEventSchema.safeParse(JSON.parse(message.data as string))
    if (!parsed.success) return
    const event = parsed.data
    if (event.type === 'workspace.changed') {
      handlers.onWorkspaceChanged?.(event.root, event.label)
      return
    }
    // Every other event is about the workspace the server is on; while this tab still shows the
    // one it left (`moved`), those would land on the wrong documents, settings and jobs.
    if (store.get().moved !== null) return
    if (event.type === 'doc.changed') void onDocChanged(event.ref, event.hash)
    else if (event.type === 'skills.changed') {
      void refreshSkills().catch((error: unknown) =>
        notifyFailure('Could not reload the skills', error),
      )
    } else if (event.type === 'config.changed') {
      void refreshConfig().catch((error: unknown) =>
        notifyFailure('Could not reload the settings', error),
      )
    } else handlers.onJobEvent?.(event)
  }
  return () => source.close()
}

let listeningForHash = false

export async function start(): Promise<void> {
  store.set((state) => ({ ...state, boot: 'loading' }))
  try {
    await Promise.all([refreshArticles(), refreshConfig(), refreshSkills(), refreshWorkspaces()])
    // What a reload kept is for the workspace the tab showed; the server may be on another now.
    acceptRestore(store.get().workspaces?.active.root ?? null)
    const fromHash = hashToRef(window.location.hash)
    const first = store.get().articles[0]
    const initial =
      fromHash ?? (first === undefined ? null : ({ kind: 'article', slug: first.slug } as const))
    if (initial !== null) await openDoc(initial)
    for (const ref of restoredRefs()) preload(ref)
    store.set((state) => ({ ...state, boot: 'ready' }))
    announceSkillErrors()
  } catch (error) {
    // Nothing is restored into a page that did not start; its jobs go stale as before.
    acceptRestore(null)
    store.set((state) => ({ ...state, boot: { error: (error as Error).message } }))
    return
  }
  if (listeningForHash) return
  listeningForHash = true
  window.addEventListener('hashchange', () => {
    const ref = hashToRef(window.location.hash)
    if (ref !== null) void openDoc(ref)
  })
}
