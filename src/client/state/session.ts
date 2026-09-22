import { z } from 'zod'
import { type DocRef, DocRefSchema } from '../../shared/api-types.ts'
import { serialise } from '../../shared/blocks/serialise.ts'
import { BlockIdSchema, type Doc } from '../../shared/blocks/types.ts'
import { type Job, JobRequestSchema, SnapshotSchema } from '../../shared/jobs/job-types.ts'
import { type Conflict, type DocState, docReducer } from './doc-reducer.ts'

/**
 * What a page reload keeps: which tab this is, the block identity of every open document, and the
 * requests this tab has not handed to the server yet. It lives in the tab's `sessionStorage` —
 * never in the article, never on the server — and only across one reload: it is read and removed
 * as the page starts, and written again as the page goes (`pagehide`). So a tab duplicated while
 * this one is open starts without it, and gets block IDs, and jobs, of its own.
 */
export const TAB_KEY = 'openwrite.tab'
export const SESSION_KEY = 'openwrite.session'

const HeldRequestSchema = z.object({
  id: z.string(),
  request: JobRequestSchema.omit({ snapshot: true }),
  blockedBy: z.array(z.string()),
})

/** A conflict a reload found and the writer has not settled: its text is nowhere else. */
const ConflictSchema = z.object({
  id: z.string().regex(/^c\d+$/),
  mine: z.string(),
  theirs: z.string(),
  written: z.string(),
  blockIds: z.array(BlockIdSchema),
  afterId: BlockIdSchema.nullable(),
})

/**
 * How much merge-base text a session keeps, over all its documents together (UTF-16 code units,
 * which is what `sessionStorage` counts). A base is kept only for a document that is ahead of
 * the disk; a blog post is tens of kilobytes, and the budget keeps a large one from filling the
 * storage and losing the whole session (`persistOnHide` then writes nothing).
 */
export const BASE_BUDGET = 1_000_000

const RestoredDocSchema = z.object({
  ref: DocRefSchema,
  doc: SnapshotSchema,
  nextId: z.number().int().min(1),
  conflicts: z.array(ConflictSchema).default([]),
  /**
   * The text last loaded or saved, when the document was ahead of it: the base of the three-way
   * merge the next page runs against the disk (#38). Absent, the kept text itself is the base,
   * so the disk's text is taken wherever it differs.
   */
  base: z.string().max(BASE_BUDGET).optional(),
  /** The text of a save that was on its way; if the disk holds exactly it, it is the base. */
  sent: z.string().max(BASE_BUDGET).optional(),
})
export type RestoredDoc = {
  ref: DocRef
  doc: Doc
  nextId: number
  conflicts: Conflict[]
  base?: string
  sent?: string
}

const SessionSchema = z.object({
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
  return {
    ref: entry.ref,
    doc: { blocks, gaps },
    nextId: Math.max(entry.nextId, highest + 1),
    conflicts: entry.conflicts,
    ...(entry.base === undefined ? {} : { base: entry.base }),
    ...(entry.sent === undefined ? {} : { sent: entry.sent }),
  }
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
 * committed — the text the writer sees, which is what autosave writes — and the jobs part. A
 * document ahead of the disk also keeps its merge base (and the save on its way), so the next
 * page can tell the writer's unsaved changes from the disk's and keep both (#38); within
 * `BASE_BUDGET`, first documents first. One past the budget keeps none, and the disk wins there.
 */
export function sessionOf(root: string, docs: DocState[], jobs: JobsPart): Session {
  let budget = BASE_BUDGET
  return {
    version: 1,
    root,
    docs: docs
      .filter((state) => state.status === 'ready')
      .map((state) => {
        const committed = docReducer(state, { type: 'blur' })
        const kept = {
          ref: state.ref,
          doc: committed.doc,
          nextId: committed.nextId,
          conflicts: state.conflicts,
        }
        const text = serialise(committed.doc)
        // A save of exactly this text is no base of its own: whether it landed or not, the
        // disk then either matches the kept text or is still the base.
        const sent = state.sentText !== null && state.sentText !== text ? state.sentText : null
        if (text === state.savedText && sent === null) return kept
        const cost = state.savedText.length + (sent?.length ?? 0)
        if (cost > budget) return kept
        budget -= cost
        return { ...kept, base: state.savedText, ...(sent === null ? {} : { sent }) }
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
