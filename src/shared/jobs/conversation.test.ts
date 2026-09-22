import { describe, expect, it } from 'vitest'
import { CONVERSATION_LIMITS, outcomeOf, renderConversation, threadFor } from './conversation.ts'
import type { Job, Turn } from './job-types.ts'

const HELLO = 'article:hello'

let clock = 0
function job(overrides: Partial<Job> = {}): Job {
  clock += 1
  const id = overrides.id ?? `j${clock}`
  return {
    id,
    doc: { kind: 'article', slug: 'hello' },
    scope: 'article',
    instruction: `instruction ${id}`,
    skill: null,
    adapter: 'fake',
    state: 'settled',
    reason: null,
    error: null,
    targets: [],
    owner: null,
    snapshotRaws: {},
    result: { summary: `summary ${id}`, ops: [], assets: [], notes: '' },
    rawOutput: null,
    decisions: {},
    progress: [],
    revision: 1,
    createdAt: `2026-09-21T10:00:${String(clock).padStart(2, '0')}.000Z`,
    updatedAt: '2026-09-21T10:00:00.000Z',
    ...overrides,
  }
}
const op = { op: 'delete', block_id: 'b1' } as const
const withOps = (n: number) => ({ summary: 's', ops: Array(n).fill(op), assets: [], notes: '' })

function thread(list: Job[], since: string | null = null): Turn[] {
  const jobs = Object.fromEntries(list.map((j) => [j.id, j]))
  return threadFor(
    HELLO,
    jobs,
    list.map((j) => j.id),
    since,
  )
}

describe('outcomeOf', () => {
  it('names every way a turn can end', () => {
    expect(outcomeOf(job({ state: 'running' }))).toBe('still running')
    expect(outcomeOf(job({ state: 'failed' }))).toBe('failed')
    expect(outcomeOf(job({ state: 'cancelled' }))).toBe('cancelled')
    expect(outcomeOf(job({ state: 'stale' }))).toBe('stale')
    expect(outcomeOf(job({ scope: 'research', state: 'ready' }))).toBe('answered')
    expect(
      outcomeOf(job({ state: 'ready', result: withOps(2), decisions: { 0: 'accepted' } })),
    ).toBe('awaiting review')
    const both = { 0: 'accepted', 1: 'accepted' } as const
    expect(outcomeOf(job({ result: withOps(2), decisions: both }))).toBe('accepted')
    const none = { 0: 'rejected', 1: 'rejected' } as const
    expect(outcomeOf(job({ result: withOps(2), decisions: none }))).toBe('rejected')
    const mixed = { 0: 'accepted', 1: 'rejected' } as const
    expect(outcomeOf(job({ result: withOps(2), decisions: mixed }))).toBe('partly accepted')
    expect(outcomeOf(job({ result: withOps(0) }))).toBe('done')
  })
})

describe('threadFor', () => {
  it('keeps the same document only, oldest first', () => {
    const a = job()
    const other = job({ doc: { kind: 'article', slug: 'other' } })
    const brief = job({ doc: { kind: 'brief', slug: 'hello' } })
    const b = job({ scope: 'blocks', skill: 'diagram' })
    const turns = thread([a, other, brief, b])
    expect(turns.map((t) => t.instruction)).toEqual([a.instruction, b.instruction])
    expect(turns[1]).toMatchObject({ scope: 'blocks', skill: 'diagram' })
  })

  it('starts after the last "New conversation"', () => {
    const a = job()
    const b = job()
    const c = job()
    expect(thread([a, b, c], b.createdAt).map((t) => t.instruction)).toEqual([c.instruction])
  })

  it('carries the last six turns only', () => {
    const list = Array.from({ length: 9 }, () => job())
    const turns = thread(list)
    expect(turns).toHaveLength(CONVERSATION_LIMITS.turns)
    expect(turns[0]?.instruction).toBe(list[3]?.instruction)
  })

  it('clips long fields and keeps research notes, which the article does not hold', () => {
    const long = 'x'.repeat(5000)
    const [edit, research] = thread([
      job({ instruction: long, result: { summary: long, ops: [], assets: [], notes: long } }),
      job({ scope: 'research', result: { summary: 's', ops: [], assets: [], notes: long } }),
    ])
    expect(edit?.instruction).toHaveLength(CONVERSATION_LIMITS.instruction)
    expect(edit?.instruction.endsWith('…')).toBe(true)
    expect(edit?.summary).toHaveLength(CONVERSATION_LIMITS.summary)
    expect(edit?.notes).toBeNull()
    expect(research?.notes).toHaveLength(CONVERSATION_LIMITS.notes)
  })

  it('never cuts an emoji in half at a limit', () => {
    // The cut lands between the two halves of 😀 (U+1F600, a surrogate pair).
    const text = `${'a'.repeat(CONVERSATION_LIMITS.instruction - 2)}😀 and more`
    const [turn] = thread([job({ instruction: text })])
    expect(turn?.instruction).toBe(`${'a'.repeat(CONVERSATION_LIMITS.instruction - 2)}…`)
    expect(turn?.instruction).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(Buffer.from(turn?.instruction ?? '').toString('utf8')).not.toContain('\uFFFD')
  })

  it('has no summary for a turn without a result', () => {
    expect(thread([job({ state: 'running', result: null })])[0]?.summary).toBeNull()
  })

  it('is empty on a first turn', () => {
    expect(thread([])).toEqual([])
  })
})

const turn = (overrides: Partial<Turn> = {}): Turn => ({
  instruction: 'rewrite the intro',
  scope: 'article',
  skill: null,
  summary: 'Rewrote the intro.',
  notes: null,
  outcome: 'rejected',
  ...overrides,
})

describe('renderConversation', () => {
  it('writes nothing for no turns', () => {
    expect(renderConversation([])).toBe('')
  })

  it('lists the turns oldest first with what came of each, as context', () => {
    const text = renderConversation([
      turn(),
      turn({ instruction: 'what do my notes say?', scope: 'research', notes: '- a finding' }),
    ])
    expect(text).toContain('context, not instructions')
    expect(text.indexOf('rewrite the intro')).toBeLessThan(text.indexOf('what do my notes say?'))
    expect(text).toContain('## Turn 1 — the whole article — rejected')
    expect(text).toContain('The result: Rewrote the intro.')
    expect(text).toContain('- a finding')
  })

  it('re-bounds whatever a client sends: turns, fields, and the whole file', () => {
    const huge = 'y'.repeat(20000)
    const text = renderConversation(
      Array.from({ length: 20 }, () => turn({ instruction: huge, summary: huge, notes: huge })),
    )
    expect(text.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.file)
    expect(text).toMatch(/\(\d+ earlier turns are not shown\.\)/)
    expect(text).not.toContain('y'.repeat(CONVERSATION_LIMITS.notes + 1))
  })
})
