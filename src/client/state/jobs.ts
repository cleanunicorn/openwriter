import { type DocRef, docKey } from '../../shared/api-types.ts'
import { applyOps } from '../../shared/jobs/apply-ops.ts'
import { threadFor } from '../../shared/jobs/conversation.ts'
import { rewriteAssetRefs } from '../../shared/jobs/asset-refs.ts'
import {
  isActive,
  isUnsettled,
  type Job,
  type JobRequest,
  PROGRESS_TAIL,
} from '../../shared/jobs/job-types.ts'
import type { Op } from '../../shared/jobs/result-schema.ts'
import { blockersOf, type Claim, lostItsTargets, startable } from '../../shared/jobs/scheduler.ts'
import { effectiveTargets } from '../../shared/jobs/validate-ops.ts'
import { api } from '../api.ts'
import {
  dispatchDoc,
  docStateOf,
  flush,
  flushAll,
  hasUnsavedChanges,
  notifyFailure,
  setEventHandlers,
  store,
} from './app.ts'
import { liveDoc } from './doc-reducer.ts'
import { setRightOpen } from '../shell/state.ts'
import { createStore, useStoreSlice } from './store.ts'

/** A request the scheduler holds back until the jobs ahead of it are settled. */
export type HeldRequest = { id: string; request: Omit<JobRequest, 'snapshot'>; blockedBy: string[] }

export type JobsState = {
  jobs: Record<string, Job>
  order: string[]
  held: HeldRequest[]
  /** jobId → op index → IDs of the blocks that op inserted (keeps result order across accepts). */
  inserted: Record<string, Record<number, string[]>>
  researchJobId: string | null
  /** The right panel's unsent message: it survives closing the panel. */
  composer: ComposerDraft
  /** When the writer last started a new conversation (ISO time); earlier jobs are not carried. */
  threadStart: string | null
}

export type ComposerDraft = { text: string; scope: 'article' | 'research' }
const EMPTY_COMPOSER: ComposerDraft = { text: '', scope: 'article' }

const jobsStore = createStore<JobsState>({
  jobs: {},
  order: [],
  held: [],
  inserted: {},
  researchJobId: null,
  composer: EMPTY_COMPOSER,
  threadStart: null,
})
export const useJobs = <T>(selector: (state: JobsState) => T): T =>
  useStoreSlice(jobsStore, selector)

const createdHere = new Set<string>()
let deciding = 0
/** jobId → op indices whose decision is on its way to the server. */
const inFlight = new Map<string, Set<number>>()
/** Requests that left the held list but whose job the server has not confirmed yet. */
const posting = new Map<string, Claim>()
let heldCounter = 0
let firstSync = true

const claimOfJob = (job: Job): Claim => ({
  id: job.id,
  docKey: docKey(job.doc),
  scope: job.scope,
  targets: job.targets,
})
const claimOfHeld = (held: HeldRequest): Claim => ({
  id: held.id,
  docKey: docKey(held.request.doc),
  scope: held.request.scope,
  targets: held.request.targets,
})
const unsettledClaims = (state: JobsState): Claim[] => [
  ...state.order.flatMap((id) => {
    const job = state.jobs[id]
    return job !== undefined && isUnsettled(job.state) ? [claimOfJob(job)] : []
  }),
  ...posting.values(),
]

function upsert(job: Job): void {
  // The POST response can arrive after newer SSE events for the same job; never go backwards.
  const known = jobsStore.get().jobs[job.id]
  if (known !== undefined && known.revision >= job.revision && known !== job) return
  const answered = job.scope === 'research' && job.state === 'ready' && known?.state !== 'ready'
  jobsStore.set((state) => ({
    ...state,
    jobs: { ...state.jobs, [job.id]: job },
    order: state.order.includes(job.id) ? state.order : [...state.order, job.id],
    // A research answer opens its panel when it arrives; nothing steals the keyboard focus.
    researchJobId: answered ? job.id : state.researchJobId,
  }))
  // The answer shows in the agent panel, opened for it; the keyboard stays where the writer is.
  if (answered) setRightOpen(true)
}

/** Post a request with a fresh snapshot of the live document, focused editor included. */
async function post(held: HeldRequest): Promise<void> {
  const { request } = held
  posting.set(held.id, claimOfHeld(held))
  try {
    await postNow(request)
  } finally {
    posting.delete(held.id)
    pump()
  }
}

async function postNow(request: Omit<JobRequest, 'snapshot'>): Promise<void> {
  await flush(request.doc)
  const docState = docStateOf(request.doc)
  if (docState === undefined) return
  const doc = liveDoc(docState)
  const snapshot = { blocks: doc.blocks, gaps: doc.gaps }
  const targets = effectiveTargets(request.scope, request.targets, snapshot)
  // Picked now, not when the request was made: a held request then carries what became of the
  // job it waited for. A conversation's first turn sends no field at all.
  const { jobs, order, threadStart } = jobsStore.get()
  const conversation = threadFor(docKey(request.doc), jobs, order, threadStart)
  try {
    const job = await api.createJob({
      ...request,
      targets,
      snapshot,
      ...(conversation.length > 0 ? { conversation } : {}),
    })
    createdHere.add(job.id)
    upsert(job)
  } catch (error) {
    dispatchDoc(request.doc, {
      type: 'notice',
      notice: `Could not start the job: ${(error as Error).message}`,
    })
  }
}

/** Start every held request whose blockers are settled; keep the rest, with who blocks them. */
function pump(): void {
  const state = jobsStore.get()
  // While a decision is being applied the document is about to change: a job started now would
  // snapshot the text from before the accept. The decision pumps again when it is done.
  if (state.held.length === 0 || deciding > 0) return
  const unsettled = unsettledClaims(state)
  const ready = new Set(startable(state.held.map(claimOfHeld), unsettled).map((claim) => claim.id))
  const starting = state.held.filter((held) => ready.has(held.id))
  const stillHeld = state.held.filter((held) => !ready.has(held.id))
  const waiting = stillHeld.map((held, index) => ({
    ...held,
    blockedBy: blockersOf(claimOfHeld(held), [
      ...unsettled,
      ...stillHeld.slice(0, index).map(claimOfHeld),
    ]),
  }))
  jobsStore.set((current) => ({ ...current, held: waiting }))
  for (const held of starting) void post(held)
}

/**
 * Entry point for the prompt pill and palette actions. The writer never waits: the request either
 * starts now or is held until the jobs it conflicts with are accepted or rejected.
 */
export function requestJob(request: Omit<JobRequest, 'snapshot'>): void {
  const held: HeldRequest = { id: `held-${++heldCounter}`, request, blockedBy: [] }
  jobsStore.set((state) => ({ ...state, held: [...state.held, held] }))
  pump()
}

export const dropHeld = (id: string) =>
  jobsStore.set((state) => ({ ...state, held: state.held.filter((held) => held.id !== id) }))

export async function cancelJob(id: string): Promise<void> {
  try {
    upsert(await api.cancelJob(id))
  } catch (error) {
    notifyFailure('Could not cancel the job', error, jobsStore.get().jobs[id]?.doc)
  }
  pump()
}

export async function dismissJob(id: string): Promise<void> {
  const job = jobsStore.get().jobs[id]
  try {
    if (job?.state === 'ready') await decide(id, [], undecided(job))
    // decide() reports its own failure; a job that is still waiting for review is not dismissed.
    if (jobsStore.get().jobs[id]?.state === 'ready') return
    await api.dismissJob(id)
  } catch (error) {
    notifyFailure('Could not dismiss the job', error, job?.doc)
    return
  }
  jobsStore.set((state) => {
    const { [id]: _gone, ...jobs } = state.jobs
    return {
      ...state,
      jobs,
      order: state.order.filter((other) => other !== id),
      researchJobId: state.researchJobId === id ? null : state.researchJobId,
    }
  })
}

export const undecided = (job: Job): number[] =>
  (job.result?.ops ?? [])
    .map((_, index) => index)
    .filter((index) => job.decisions[String(index)] === undefined)

/**
 * Accept and/or reject ops. The server copies the accepted ops' assets into the bundle and
 * returns the final names; references are rewritten and the ops applied to the *current* text
 * as one undoable step. Undoing it later is an ordinary edit: it never re-runs the job.
 */
export async function decide(
  id: string,
  wantAccepted: number[],
  wantRejected: number[],
): Promise<void> {
  const job = jobsStore.get().jobs[id]
  if (job === undefined || job.result === null || job.state !== 'ready') return
  // An op is decided once. A second click, a key repeat, or "Accept" followed by "Accept all"
  // inside one round trip must not apply the same insertion twice.
  const pending = inFlight.get(id) ?? new Set<number>()
  inFlight.set(id, pending)
  const fresh = (index: number) => job.decisions[String(index)] === undefined && !pending.has(index)
  const accepted = [...new Set(wantAccepted)].filter(fresh)
  const rejected = [...new Set(wantRejected)].filter(
    (index) => fresh(index) && !accepted.includes(index),
  )
  if (accepted.length + rejected.length === 0 && job.result.ops.length > 0) return
  for (const index of [...accepted, ...rejected]) pending.add(index)
  deciding++
  try {
    await applyDecision(job, accepted, rejected)
  } catch (error) {
    // The ghost stays on screen: nothing was applied, and the writer can decide again.
    notifyFailure('Could not record the decision', error, job.doc)
  } finally {
    for (const index of [...accepted, ...rejected]) pending.delete(index)
    deciding--
    pump()
  }
}

async function applyDecision(job: Job, accepted: number[], rejected: number[]): Promise<void> {
  const id = job.id
  if (job.result === null) return
  // An accepted replace or delete of the block that is being edited must win over the open
  // editor's draft — otherwise the draft is folded over the accepted text on the next save and
  // the writer's decision silently disappears. Commit the draft first (it stays in the undo
  // history), then apply. An editor on any other block is left alone.
  const focusedId = docStateOf(job.doc)?.focusedId ?? null
  const touchesFocused = accepted.some((index) => {
    const op = job.result?.ops[index]
    return (
      op !== undefined &&
      op.op !== 'insert_after' &&
      op.op !== 'insert_before' &&
      op.block_id === focusedId
    )
  })
  if (touchesFocused) dispatchDoc(job.doc, { type: 'blur' })

  const decided = await api.decide(id, accepted, rejected)
  let updated = decided.job
  const docState = docStateOf(job.doc)
  if (docState !== undefined && accepted.length > 0) {
    const ops: Op[] = job.result.ops.map((op) =>
      op.op === 'delete'
        ? op
        : { ...op, markdown: rewriteAssetRefs(op.markdown, decided.assetMap) },
    )
    let next = docState.nextId
    const result = applyOps(
      docState.doc,
      accepted.map((index) => ({ index, op: ops[index] as Op })),
      ops,
      jobsStore.get().inserted[id] ?? {},
      () => `b${next++}`,
    )
    dispatchDoc(job.doc, { type: 'replace-doc', doc: result.doc, nextId: next })
    jobsStore.set((state) => ({
      ...state,
      inserted: { ...state.inserted, [id]: { ...state.inserted[id], ...result.inserted } },
    }))
    if (result.missing.length > 0) {
      dispatchDoc(job.doc, {
        type: 'notice',
        notice: 'Part of the proposal could not be applied: its block no longer exists.',
      })
      // The server recorded these as accepted before this client could know that their block
      // was gone (it vanished during the round trip). What was not applied is not accepted.
      updated = await api.withdrawDecisions(id, result.missing).catch((error) => {
        notifyFailure('Could not take back the decision', error, job.doc)
        return updated
      })
      // An earlier stale report may have been a no-op on the then-settled job: report again.
      reportedStale.delete(id)
    }
  }
  upsert(updated)
  checkTargets()
}

export const acceptAll = (id: string) => {
  const job = jobsStore.get().jobs[id]
  return job === undefined ? Promise.resolve() : decide(id, undecided(job), [])
}
export const rejectAll = (id: string) => {
  const job = jobsStore.get().jobs[id]
  return job === undefined ? Promise.resolve() : decide(id, [], undecided(job))
}

export function insertNote(job: Job, markdown: string): void {
  const docState = docStateOf(job.doc)
  if (docState === undefined) return
  const anchor = [...job.targets]
    .reverse()
    .find((id) => docState.doc.blocks.some((block) => block.id === id))
  const index =
    anchor === undefined
      ? docState.doc.blocks.length
      : docState.doc.blocks.findIndex((b) => b.id === anchor) + 1
  dispatchDoc(job.doc, { type: 'insert', index, markdown })
}

/** "New conversation": the next message carries none of the turns before it. */
export const startNewConversation = () =>
  jobsStore.set((state) => ({ ...state, threadStart: new Date().toISOString() }))

/** The turns the next message about `ref` would carry. */
export const threadOf = (state: JobsState, ref: DocRef) =>
  threadFor(docKey(ref), state.jobs, state.order, state.threadStart)

export const setComposer = (patch: Partial<ComposerDraft>) =>
  jobsStore.set((state) => ({ ...state, composer: { ...state.composer, ...patch } }))
export const setResearchJob = (researchJobId: string | null) =>
  jobsStore.set((state) => ({ ...state, researchJobId }))

/** Jobs and held requests that still hold a claim on a block of `ref`. */
export function claimsOn(
  state: JobsState,
  ref: DocRef,
): { pending: Set<string>; queued: Set<string> } {
  const key = docKey(ref)
  const pending = new Set<string>()
  const queued = new Set<string>()
  for (const id of state.order) {
    const job = state.jobs[id]
    if (job === undefined || docKey(job.doc) !== key) continue
    if (isActive(job.state)) {
      for (const target of job.targets) pending.add(target)
    }
  }
  for (const held of state.held) {
    if (docKey(held.request.doc) === key)
      for (const target of held.request.targets) queued.add(target)
  }
  return { pending, queued }
}

// A deleted target makes the job stale: its output stays in the tray, nothing is guessed.
const reportedStale = new Set<string>()
function checkTargets(): void {
  const { jobs, order, held } = jobsStore.get()
  for (const id of order) {
    const job = jobs[id]
    if (job === undefined || !isUnsettled(job.state) || reportedStale.has(id)) continue
    const docState = docStateOf(job.doc)
    if (docState === undefined || docState.status !== 'ready') continue
    const ids = docState.doc.blocks.map((block) => block.id)
    // While a target is being edited its text may be empty for a moment; only a committed delete counts.
    if (!lostItsTargets(job.scope, job.targets, ids)) continue
    reportedStale.add(id)
    void api
      .staleJob(id, 'A target block was deleted before the result was reviewed.')
      .then(upsert)
      .then(pump)
      // Not recorded as reported: the next document change tries again.
      .catch(() => reportedStale.delete(id))
  }
  for (const request of held) {
    const docState = docStateOf(request.request.doc)
    if (docState === undefined) continue
    const ids = docState.doc.blocks.map((block) => block.id)
    if (lostItsTargets(request.request.scope, request.request.targets, ids)) {
      dropHeld(request.id)
      dispatchDoc(request.request.doc, {
        type: 'notice',
        notice: 'A queued instruction was dropped: its block was deleted.',
      })
    }
  }
}

async function sync(): Promise<void> {
  const { jobs } = await api.jobs()
  for (const job of jobs) {
    // A page reload regenerated every block ID, so reviews from before it cannot be applied.
    if (firstSync && isUnsettled(job.state) && !createdHere.has(job.id)) {
      upsert(
        await api.staleJob(
          job.id,
          'The page was reloaded before this job was reviewed. Its output is kept here.',
        ),
      )
    } else {
      upsert(job)
    }
  }
  firstSync = false
  pump()
}

/**
 * Forget this workspace's jobs and load the other one's. Everything keyed by job id has to go:
 * the transcript, the held requests, the decisions on their way to the server, and the module state
 * beside the store. `firstSync` goes back to true for the same reason a page reload sets it —
 * the client holds no block IDs for the new workspace's documents, so a job found unsettled
 * there cannot be applied and is marked stale with its output kept.
 */
export async function resetJobs(): Promise<void> {
  jobsStore.set(() => ({
    jobs: {},
    order: [],
    held: [],
    inserted: {},
    researchJobId: null,
    composer: EMPTY_COMPOSER,
    threadStart: null,
  }))
  createdHere.clear()
  inFlight.clear()
  posting.clear()
  reportedStale.clear()
  deciding = 0
  firstSync = true
  await sync()
}

export function startJobs(): void {
  setEventHandlers({
    onConnect: () =>
      void sync().catch((error: unknown) => notifyFailure('Could not load the jobs', error)),
    onJobEvent: (event) => {
      if (event.type === 'job.state') {
        upsert(event.job)
        pump()
      } else if (event.type === 'job.progress') {
        jobsStore.set((state) => {
          const job = state.jobs[event.id]
          if (job === undefined) return state
          return {
            ...state,
            jobs: {
              ...state.jobs,
              [event.id]: { ...job, progress: [...job.progress, event.text].slice(-PROGRESS_TAIL) },
            },
          }
        })
      }
    },
  })
  store.subscribe(checkTargets)
  window.addEventListener('beforeunload', (event) => {
    const { held, jobs } = jobsStore.get()
    const open =
      held.length > 0 ||
      Object.values(jobs).some((job) => createdHere.has(job.id) && isUnsettled(job.state))
    // A dirty document counts too: autosave is debounced, so the last keystrokes may still be
    // on their way when the tab closes.
    if (open || hasUnsavedChanges()) event.preventDefault()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll()
  })
}
