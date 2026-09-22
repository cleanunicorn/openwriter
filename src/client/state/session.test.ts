import { describe, expect, it } from 'vitest'
import { serialise } from '../../shared/blocks/index.ts'
import { TabIdSchema } from '../../shared/jobs/job-types.ts'
import {
  type DocAction,
  type DocState,
  docReducer,
  initialDocState,
  liveText,
} from './doc-reducer.ts'
import {
  parseSession,
  type Session,
  sessionFor,
  sessionOf,
  stillApplicable,
  mintTabId,
  takeItem,
} from './session.ts'

const REF = { kind: 'article', slug: 'post' } as const
const TEXT = 'A\n\nB\n\nC\n'
const NO_JOBS = { held: [], inserted: {}, threadStarts: {}, drafts: {} }

const run = (state: DocState, ...actions: DocAction[]) => actions.reduce(docReducer, state)
const load = (text: string, restore?: { doc: Session['docs'][number]['doc']; nextId: number }) =>
  docReducer(initialDocState(REF), {
    type: 'loaded',
    text,
    hash: 'h',
    exists: true,
    ...(restore === undefined ? {} : { restore }),
  })
const ids = (state: DocState) => state.doc.blocks.map((block) => block.id)

/** What a reload does: write the session as the page goes, read it back as the next one starts. */
function reload(state: DocState): Session['docs'][number] {
  const kept = parseSession(JSON.stringify(sessionOf('/ws', [state], NO_JOBS)))
  const doc = kept?.docs[0]
  if (doc === undefined) throw new Error('nothing kept')
  return doc
}

describe('a page reload', () => {
  it('gives every block back the ID it had, and the counter goes on from where it was', () => {
    // An edit that split a block minted b4; the open editor holds b3's draft, not committed yet.
    const before = run(
      load(TEXT),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'commit', id: 'b2', text: 'B\n\nB two' },
      { type: 'focus', id: 'b3', cursor: 0 },
      { type: 'draft', id: 'b3', text: 'C typed' },
    )
    expect(ids(before)).toEqual(['b1', 'b2', 'b4', 'b3'])
    // Autosave wrote the live text, draft included; that is what the next page loads.
    const disk = liveText(before)
    const kept = reload(before)
    const after = load(disk, kept)
    expect(ids(after)).toEqual(['b1', 'b2', 'b4', 'b3'])
    expect(serialise(after.doc)).toBe(disk)
    // A block made after the reload never takes an ID from before it.
    const next = run(after, { type: 'insert', index: 0, markdown: 'New' })
    expect(ids(next)[0]).toBe('b5')
  })

  it('keeps no ID on a block whose text changed on disk while the page was away', () => {
    const kept = reload(load(TEXT))
    const after = load('A\n\nSomething else entirely\n\nC\n', kept)
    expect(ids(after)).toEqual(['b1', 'b4', 'b3'])
  })

  it('keeps the untouched blocks when the file was rewritten around them', () => {
    const kept = reload(load(TEXT))
    const after = load('Intro\n\nA\n\nC\n\nOutro\n', kept)
    expect(ids(after)).toEqual(['b4', 'b1', 'b3', 'b5'])
  })

  it('keeps only documents that loaded', () => {
    const loading = initialDocState({ kind: 'brief', slug: 'post' })
    const session = sessionOf('/ws', [load(TEXT), loading], NO_JOBS)
    expect(session.docs.map((doc) => doc.ref)).toEqual([REF])
  })

  it('keeps the held requests and the jobs bookkeeping as they were', () => {
    const jobs = {
      held: [
        {
          id: 'held-3',
          request: {
            doc: REF,
            scope: 'blocks' as const,
            instruction: 'shorter',
            targets: ['b2'],
          },
          blockedBy: ['job-1'],
        },
      ],
      inserted: { 'job-1': { '0': ['b7', 'b8'] } },
      threadStarts: { 'article:post': '2026-09-22T10:00:00.000Z' },
      drafts: { 'article:post': { text: 'half a thought', scope: 'article' as const } },
    }
    const kept = parseSession(JSON.stringify(sessionOf('/ws', [], jobs)))
    expect(kept).toMatchObject({ root: '/ws', ...jobs })
  })

  it('keeps a conflict the writer has not settled: its text is nowhere else', () => {
    const conflicted = run(
      load(TEXT),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'commit', id: 'b2', text: 'B mine' },
      { type: 'external', text: 'A\n\nB disk\n\nC\n', hash: 'h1', exists: true },
    )
    expect(conflicted.conflicts).toHaveLength(1)
    const after = load(serialise(conflicted.doc), reload(conflicted))
    expect(after.conflicts).toEqual(conflicted.conflicts)
    expect(after.notice).toContain('Choose which version to keep')
    // A new conflict after the reload gets an ID of its own.
    expect(after.nextConflict).toBeGreaterThan(Number(conflicted.conflicts[0]?.id.slice(1)))
    const resolved = docReducer(after, {
      type: 'resolve',
      id: after.conflicts[0]?.id ?? '',
      keep: 'mine',
    })
    expect(serialise(resolved.doc)).toBe('A\n\nB mine\n\nC\n')
  })
})

describe('what a reload reads back', () => {
  const good = sessionOf('/ws', [load(TEXT)], NO_JOBS)

  it('is used only in the workspace it was written in', () => {
    expect(sessionFor(good, '/ws')).toBe(good)
    // Another tab switched the server meanwhile: same slugs, other articles.
    expect(sessionFor(good, '/other')).toBeNull()
    expect(sessionFor(good, null)).toBeNull()
    expect(sessionFor(null, '/ws')).toBeNull()
  })

  it('is nothing when there was nothing, or it is not a session', () => {
    expect(parseSession(null)).toBeNull()
    expect(parseSession('{not json')).toBeNull()
    expect(parseSession(JSON.stringify({ ...good, version: 2 }))).toBeNull()
    expect(parseSession(JSON.stringify({ ...good, root: 7 }))).toBeNull()
  })

  it('drops a document whose blocks and gaps do not fit, or that names an ID twice', () => {
    const [doc] = good.docs
    if (doc === undefined) throw new Error('no doc')
    const gaps = { ...doc, doc: { ...doc.doc, gaps: doc.doc.gaps.slice(1) } }
    const [first] = doc.doc.blocks
    if (first === undefined) throw new Error('no block')
    const twice = { ...doc, doc: { ...doc.doc, blocks: doc.doc.blocks.map(() => first) } }
    const derived = {
      ...doc,
      doc: { ...doc.doc, blocks: doc.doc.blocks.map((block) => ({ ...block, id: 'live1' })) },
    }
    for (const bad of [gaps, twice, derived]) {
      expect(parseSession(JSON.stringify({ ...good, docs: [bad] }))?.docs).toEqual([])
    }
  })

  it('moves a counter that is behind the stored IDs past them', () => {
    const [doc] = good.docs
    if (doc === undefined) throw new Error('no doc')
    const behind = parseSession(JSON.stringify({ ...good, docs: [{ ...doc, nextId: 1 }] }))
    expect(behind?.docs[0]?.nextId).toBe(4)
  })

  it('refuses a block ID that is not one', () => {
    const [doc] = good.docs
    if (doc === undefined) throw new Error('no doc')
    const blocks = doc.doc.blocks.map((block) => ({ ...block, id: '<script>' }))
    expect(
      parseSession(JSON.stringify({ ...good, docs: [{ ...doc, doc: { ...doc.doc, blocks } }] })),
    ).toBeNull()
  })
})

describe('the tab', () => {
  it('has an ID the server accepts', () => {
    expect(TabIdSchema.safeParse(mintTabId()).success).toBe(true)
  })

  it('takes a kept value only once: a copy of the tab made later finds nothing', () => {
    const values = new Map([['k', 'v']])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    }
    expect(takeItem(storage, 'k')).toBe('v')
    expect(takeItem(storage, 'k')).toBeNull()
    expect(takeItem(null, 'k')).toBeNull()
    const throwing = {
      ...storage,
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(takeItem(throwing, 'k')).toBeNull()
  })
})

describe('a job found unsettled as the tab starts', () => {
  const job = (owner: string | null, scope: 'blocks' | 'article' | 'research' = 'blocks') => ({
    owner,
    scope,
    doc: REF,
  })
  const kept = () => true
  const lost = () => false

  it('is still this tab’s to apply when the reload kept its document’s blocks', () => {
    expect(stillApplicable(job('tab-me'), 'tab-me', kept, [])).toBe(true)
    expect(stillApplicable(job('tab-me', 'article'), 'tab-me', kept, [])).toBe(true)
  })

  it('goes stale when this tab lost its document’s blocks, unless it edits none', () => {
    expect(stillApplicable(job('tab-me'), 'tab-me', lost, ['tab-me'])).toBe(false)
    expect(stillApplicable(job('tab-me', 'research'), 'tab-me', lost, [])).toBe(true)
  })

  it('is left to another tab while that tab is open, and goes stale once it is gone', () => {
    expect(stillApplicable(job('tab-other'), 'tab-me', kept, ['tab-other'])).toBe(true)
    expect(stillApplicable(job('tab-other'), 'tab-me', kept, ['tab-me'])).toBe(false)
  })

  it('goes stale when nobody knows which tab asked for it', () => {
    expect(stillApplicable(job(null), 'tab-me', kept, ['tab-me'])).toBe(false)
  })
})
