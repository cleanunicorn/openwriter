import { type DocRef, docKey } from '../../shared/api-types.ts'
import { TabIdSchema } from '../../shared/jobs/job-types.ts'
import {
  type JobsPart,
  type KeyValueStore,
  mintTabId,
  parseSession,
  type RestoredDoc,
  SESSION_KEY,
  sessionFor,
  type Session,
  TAB_KEY,
  takeItem,
} from './session.ts'

// This tab, and what its last reload kept: state/session.ts has the rules, this is the browser
// side. Read once as the page starts; written as it goes.

/** `sessionStorage` can be missing or throw (blocked site data); then nothing survives a reload. */
function storage(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** Which tab this is. Every job this tab asks for carries it; its event stream announces it. */
export const tabId: string = (() => {
  const kept = TabIdSchema.safeParse(takeItem(storage(), TAB_KEY))
  return kept.success ? kept.data : mintTabId()
})()

let restored: Session | null = parseSession(takeItem(storage(), SESSION_KEY))
/** Documents whose identity came back from before the reload; their jobs can be applied. */
let restoredKeys = new Set<string>()
let settle: () => void = () => {}
/** Resolves once `start` has decided whether the kept session belongs to the open workspace. */
export const restoreSettled = new Promise<void>((resolve) => {
  settle = resolve
})

/** Keep the session only if it was written for the workspace that is open now (`sessionFor`). */
export function acceptRestore(root: string | null): void {
  restored = sessionFor(restored, root)
  restoredKeys = new Set((restored?.docs ?? []).map((entry) => docKey(entry.ref)))
  settle()
}

/** A workspace switch: nothing from before the reload applies to what is open now. */
export function dropRestore(): void {
  restored = null
  restoredKeys = new Set()
  settle()
}

/** Documents that were open before the reload, to load again. */
export const restoredRefs = (): DocRef[] => (restored?.docs ?? []).map((entry) => entry.ref)

/** A document's identity from before the reload, once: the first load takes it. */
export function takeRestoredDoc(ref: DocRef): RestoredDoc | undefined {
  if (restored === null) return undefined
  const key = docKey(ref)
  const entry = restored.docs.find((candidate) => docKey(candidate.ref) === key)
  if (entry === undefined) return undefined
  restored = { ...restored, docs: restored.docs.filter((candidate) => candidate !== entry) }
  return entry
}

/** Did this document's identity survive the reload? Only then can its jobs land on its blocks. */
export const wasRestored = (ref: DocRef): boolean => restoredKeys.has(docKey(ref))

/** The held requests, inserted blocks, conversation starts and drafts from before the reload, once. */
export function takeRestoredJobs(): JobsPart | null {
  if (restored === null) return null
  const { held, inserted, threadStarts, drafts } = restored
  restored = { ...restored, held: [], inserted: {}, threadStarts: {}, drafts: {} }
  return { held, inserted, threadStarts, drafts }
}

/**
 * Write the tab ID and `build()`'s session as the page goes, and remove them again if it comes
 * back from the back/forward cache — a tab duplicated after that must not find them.
 */
export function persistOnHide(build: () => Session | null): void {
  window.addEventListener('pagehide', () => {
    const into = storage()
    if (into === null) return
    try {
      into.setItem(TAB_KEY, tabId)
      const session = build()
      if (session === null) into.removeItem(SESSION_KEY)
      else into.setItem(SESSION_KEY, JSON.stringify(session))
    } catch {
      // Full or blocked: the reload starts fresh, and its jobs go stale as they did before.
    }
  })
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    takeItem(storage(), TAB_KEY)
    takeItem(storage(), SESSION_KEY)
  })
}
