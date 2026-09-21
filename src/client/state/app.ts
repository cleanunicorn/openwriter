import {
  type Article,
  type ConfigResponse,
  type DocRef,
  docKey,
  type SkillInfo,
} from '../../shared/api-types.ts'
import type { Config } from '../../shared/config-schema.ts'
import type { WorkspacesResponse } from '../../shared/workspaces-schema.ts'
import { type ServerEvent, ServerEventSchema } from '../../shared/events.ts'
import { isSlug } from '../../shared/names.ts'
import { ApiError, api } from '../api.ts'
import {
  type DocAction,
  type DocState,
  docReducer,
  initialDocState,
  isDirty,
  liveText,
} from './doc-reducer.ts'
import { createStore, useStoreSlice } from './store.ts'

export type PaletteMode =
  | { kind: 'commands' }
  | { kind: 'input'; label: string; placeholder: string; submit: (value: string) => void }
  /** Like `input`, but Enter does nothing until what was typed is exactly `phrase`. */
  | {
      kind: 'confirm'
      label: string
      placeholder: string
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
  /** Prompt templates from `skills/`; the palette lists them, the editor knows nothing else. */
  skills: SkillInfo[]
  /** The open workspace and the ones the writer has opened before; the palette lists them. */
  workspaces: WorkspacesResponse | null
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
  workspaces: null,
  palette: null,
  panel: null,
  themeEpoch: 0,
})

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
  else console.error(message)
}

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
  const text = liveText(state)
  const session = docSession
  try {
    const base = state.baseHash
    const { hash } = await api.save(ref, text, base)
    if (session !== docSession) return
    dispatchDoc(ref, { type: 'saved', text, hash, baseHash: base })
  } catch (error) {
    if (session !== docSession) return
    if (error instanceof ApiError && error.status === 409) {
      // Someone else changed (or deleted) the file: reconcile instead of overwriting.
      const disk = error.body as { text: string; hash: string | null; exists: boolean }
      dispatchDoc(ref, { type: 'external', text: disk.text, hash: disk.hash, exists: disk.exists })
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

/** Is any open document ahead of the disk? Used by the unload guard. */
export const hasUnsavedChanges = (): boolean => Object.values(store.get().docs).some(isDirty)

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
    dispatchDoc(ref, { type: 'loaded', ...doc })
  } catch (error) {
    if (session !== docSession) return
    dispatchDoc(ref, { type: 'failed', error: (error as Error).message })
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

/**
 * The writer for quick toggles (theme, panels). The store changes first, so the next toggle sees
 * this one; the write is queued behind any other, and toggles made while one waits share it. While
 * any write is queued, `refreshConfig` keeps the local theme and panels, so an older copy fetched
 * in between can never flip them back. An invalid config file is never overwritten: the toggle
 * then holds for this session only.
 */
export async function saveConfigPatch(patch: ConfigPatch, failure: string): Promise<void> {
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
    const latest = store.get().config
    if (latest === null || latest.error !== null) return
    try {
      await api.saveConfig(latest.config)
    } catch (error) {
      notifyFailure(failure, error)
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
    const ui = store.get().config?.config.ui ?? draft.ui
    const saved = await api.saveConfig({ ...draft, ui })
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
  const { skills } = await api.skills()
  store.set((state) => ({ ...state, skills }))
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
  /** Another tab moved the server to a different workspace. */
  onWorkspaceChanged?: (root: string) => void
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
 * The server keeps no event log, so whatever happened while the stream was down is unknown:
 * on every (re)connect re-check each open document against the disk (through the same
 * reconcile as a live event, so a focused draft survives), the settings, and the article list.
 */
async function resync(): Promise<void> {
  const open = Object.values(store.get().docs).filter((doc) => doc.status === 'ready')
  await Promise.all([
    ...open.map(async (doc) => {
      const disk = await api.doc(doc.ref)
      if (disk.hash !== docStateOf(doc.ref)?.baseHash) {
        dispatchDoc(doc.ref, { type: 'external', ...disk })
      }
    }),
    refreshConfig(),
    refreshArticles(),
  ])
}

export function connectEvents(): () => void {
  const source = new EventSource('/api/events')
  source.addEventListener('hello', () => {
    handlers.onConnect?.()
    void resync().catch((error: unknown) =>
      notifyFailure('Could not check for outside changes', error),
    )
  })
  source.onmessage = (message) => {
    const parsed = ServerEventSchema.safeParse(JSON.parse(message.data as string))
    if (!parsed.success) return
    const event = parsed.data
    if (event.type === 'doc.changed') void onDocChanged(event.ref, event.hash)
    else if (event.type === 'workspace.changed') handlers.onWorkspaceChanged?.(event.root)
    else if (event.type === 'config.changed') {
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
    const fromHash = hashToRef(window.location.hash)
    const first = store.get().articles[0]
    const initial =
      fromHash ?? (first === undefined ? null : ({ kind: 'article', slug: first.slug } as const))
    if (initial !== null) await openDoc(initial)
    store.set((state) => ({ ...state, boot: 'ready' }))
  } catch (error) {
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
