import { z } from 'zod'
import { type DocRef, DocRefSchema } from '../../shared/api-types.ts'
import { BlockIdSchema, type Doc } from '../../shared/blocks/types.ts'
import { type Job, JobRequestSchema, SnapshotSchema } from '../../shared/jobs/job-types.ts'
import { type DocState, docReducer } from './doc-reducer.ts'

/**
 * What a page reload keeps: which tab this is, the block identity of every open document, and the
 * requests this tab has not handed to the server yet. It lives in the tab's `sessionStorage` —
 * never in the article, never on the server — and only across one reload: it is read and removed
 * as the page starts, and written again as the page goes (`pagehide`). So a tab duplicated while
 * this one is open starts without it, and gets block IDs, and jobs, of its own.
 */
export const TAB_KEY = 'openwrite.tab'
export const SESSION_KEY = 'openwrite.session'

export const HeldRequestSchema = z.object({
  id: z.string(),
  request: JobRequestSchema.omit({ snapshot: true }),
  blockedBy: z.array(z.string()),
})

const RestoredDocSchema = z.object({
  ref: DocRefSchema,
  doc: SnapshotSchema,
  nextId: z.number().int().min(1),
})
export type RestoredDoc = { ref: DocRef; doc: Doc; nextId: number }

export const SessionSchema = z.object({
  version: z.literal(1),
  /** The workspace the tab showed; a session for another one is thrown away. */
  root: z.string(),
  docs: z.array(RestoredDocSchema),
  held: z.array(HeldRequestSchema),
  inserted: z.record(z.string(), z.record(z.string(), z.array(BlockIdSchema))),
  threadStarts: z.record(z.string(), z.string()),
  drafts: z.record(
    z.string(),
    z.object({ text: z.string(), scope: z.enum(['article', 'research']) }),
  ),
})
export type Session = z.infer<typeof SessionSchema>

/**
 * A document's saved identity is usable only if it is a document: one gap more than blocks, no
 * ID twice, and a counter past every stored ID — otherwise the next block minted could take an ID
 * a job is still aimed at.
 */
function usableDoc(entry: z.infer<typeof RestoredDocSchema>): RestoredDoc | null {
  const { blocks, gaps } = entry.doc
  if (gaps.length !== blocks.length + 1) return null
  const ids = blocks.map((block) => block.id)
  if (new Set(ids).size !== ids.length || ids.some((id) => !id.startsWith('b'))) return null
  const highest = Math.max(0, ...ids.map((id) => Number(id.slice(1))))
  return { ref: entry.ref, doc: { blocks, gaps }, nextId: Math.max(entry.nextId, highest + 1) }
}

/** Parse what `sessionStorage` held. Anything that does not conform is dropped, not guessed at. */
export function parseSession(text: string | null): Session | null {
  if (text === null) return null
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return null
    const docs = parsed.data.docs.flatMap((entry) => {
      const doc = usableDoc(entry)
      return doc === null ? [] : [doc]
    })
    return { ...parsed.data, docs }
  } catch {
    return null
  }
}

/**
 * The kept session, if it was written for the workspace open now. After a switch made meanwhile
 * (by another tab) the same slugs name other articles, and their IDs must not be put on them.
 */
export const sessionFor = (session: Session | null, root: string | null): Session | null =>
  session !== null && session.root === root ? session : null

export type JobsPart = Pick<Session, 'held' | 'inserted' | 'threadStarts' | 'drafts'>

/**
 * The session to keep for `root`: each ready document as it would be with its open editor
 * committed — which is the text autosave writes, so the next load finds it — and the jobs part.
 */
export function sessionOf(root: string, docs: DocState[], jobs: JobsPart): Session {
  return {
    version: 1,
    root,
    docs: docs
      .filter((state) => state.status === 'ready')
      .map((state) => {
        const committed = docReducer(state, { type: 'blur' })
        return { ref: state.ref, doc: committed.doc, nextId: committed.nextId }
      }),
    ...jobs,
  }
}

/**
 * Can a job found unsettled as a tab starts still be applied by somebody? The tab's own, if the
 * reload kept its document's block IDs (a research job needs none); another tab's, while that tab
 * is open — it holds the IDs. Anything else has no blocks left to land on and goes stale.
 */
export function stillApplicable(
  job: Pick<Job, 'owner' | 'scope' | 'doc'>,
  tab: string,
  restored: (ref: DocRef) => boolean,
  openTabs: string[],
): boolean {
  if (job.owner === tab) return job.scope === 'research' || restored(job.doc)
  return job.owner !== null && openTabs.includes(job.owner)
}

/** The part of `sessionStorage` this needs; a plain object stands in for it in tests. */
export type KeyValueStore = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** Read a key and remove it, so that a copy of this tab cannot find it. */
export function takeItem(from: KeyValueStore | null, key: string): string | null {
  if (from === null) return null
  try {
    const value = from.getItem(key)
    from.removeItem(key)
    return value
  } catch {
    return null
  }
}

/** A new tab's ID. */
export const mintTabId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
