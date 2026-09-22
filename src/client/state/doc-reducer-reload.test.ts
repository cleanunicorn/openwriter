import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { merge3, serialise } from '../../shared/blocks/index.ts'
import {
  type DocAction,
  type DocState,
  docReducer,
  initialDocState,
  isDirty,
  liveText,
  NEW_BLOCK_ID,
} from './doc-reducer.ts'

// A reload is a three-way merge (#30): base = the text last loaded or saved, mine = the live
// document, theirs = the disk. What only one side changed is kept; what both changed differently
// is a conflict the writer settles, and the document shows the file's version meanwhile.

function loaded(text = 'One\n\nTwo\n\nThree\n'): DocState {
  return docReducer(initialDocState({ kind: 'article', slug: 'post' }), {
    type: 'loaded',
    text,
    hash: 'h0',
    exists: true,
  })
}
const run = (state: DocState, ...actions: DocAction[]) => actions.reduce(docReducer, state)
const text = (state: DocState) => serialise(state.doc)
const reload = (state: DocState, disk: string, hash = 'h1'): DocState =>
  docReducer(state, { type: 'external', text: disk, hash, exists: true })
/** Edit a block and finish it (Esc): committed to the document, not saved yet. */
const finish = (state: DocState, id: string, raw: string) =>
  run(state, { type: 'focus', id, cursor: 'end' }, { type: 'commit', id, text: raw })

describe('a reload keeps a finished block that was not saved yet (#30)', () => {
  it('keeps the block and takes the disk’s change to another one', () => {
    const state = reload(finish(loaded(), 'b2', 'Two MINE'), 'One\n\nTwo\n\nThree DISK\n')
    expect(text(state)).toBe('One\n\nTwo MINE\n\nThree DISK\n')
    expect(state.conflicts).toEqual([])
    // Still ahead of the disk, so autosave writes it; the base is the disk's revision now.
    expect(isDirty(state)).toBe(true)
    expect(state.baseHash).toBe('h1')
    expect(state.savedText).toBe('One\n\nTwo\n\nThree DISK\n')
    expect(state.notice).toBe('The file changed on disk. Your unsaved text was kept.')
  })

  it('keeps it when the refused save’s own text is not on disk (the 409 path)', () => {
    // The rejected PUT carried this very text; the disk answered with another tab's.
    const state = reload(finish(loaded(), 'b3', 'Three MINE'), 'One AAA\n\nTwo\n\nThree\n')
    expect(text(state)).toBe('One AAA\n\nTwo\n\nThree MINE\n')
  })

  it('keeps it when the disk deleted its block', () => {
    const state = reload(finish(loaded(), 'b2', 'Two MINE'), 'One\n\nThree\n')
    expect(text(state)).toBe('One\n\nTwo MINE\n\nThree\n')
    expect(state.conflicts).toEqual([])
  })

  it('keeps a finished deletion, and a finished move', () => {
    const deleted = reload(
      run(loaded(), { type: 'delete', ids: ['b2'] }),
      'One DISK\n\nTwo\n\nThree\n',
    )
    expect(text(deleted)).toBe('One DISK\n\nThree\n')
    const moved = reload(
      run(loaded(), { type: 'move', from: 2, to: 0 }),
      'One\n\nTwo DISK\n\nThree\n',
    )
    expect(text(moved)).toBe('Three\n\nOne\n\nTwo DISK\n')
  })
})

describe('a block both sides changed becomes a conflict, never a silent loss', () => {
  const conflicted = () => reload(finish(loaded(), 'b2', 'Two MINE'), 'One\n\nTwo DISK\n\nThree\n')

  it('shows the disk’s version and keeps the writer’s aside', () => {
    const state = conflicted()
    expect(text(state)).toBe('One\n\nTwo DISK\n\nThree\n')
    expect(state.conflicts).toHaveLength(1)
    expect(state.conflicts[0]).toMatchObject({ mine: 'Two MINE', theirs: 'Two DISK' })
    // The document is the file: nothing to autosave, so the other side's text is never overwritten.
    expect(isDirty(state)).toBe(false)
    expect(state.notice).toContain('Choose which version to keep')
  })

  it('keep mine puts the writer’s version in the disk’s place, as one undo step', () => {
    const state = conflicted()
    const kept = docReducer(state, {
      type: 'resolve',
      id: state.conflicts[0]?.id ?? '',
      keep: 'mine',
    })
    expect(text(kept)).toBe('One\n\nTwo MINE\n\nThree\n')
    expect(kept.conflicts).toEqual([])
    expect(kept.notice).toBeNull()
    expect(isDirty(kept)).toBe(true)
    expect(text(docReducer(kept, { type: 'undo' }))).toBe('One\n\nTwo DISK\n\nThree\n')
  })

  it('keep both puts the writer’s version after the disk’s', () => {
    const state = conflicted()
    const both = docReducer(state, {
      type: 'resolve',
      id: state.conflicts[0]?.id ?? '',
      keep: 'both',
    })
    expect(text(both)).toBe('One\n\nTwo DISK\n\nTwo MINE\n\nThree\n')
  })

  it('take theirs leaves the document as it is and drops the writer’s version', () => {
    const state = conflicted()
    const theirs = docReducer(state, {
      type: 'resolve',
      id: state.conflicts[0]?.id ?? '',
      keep: 'theirs',
    })
    expect(theirs.doc).toBe(state.doc)
    expect(theirs.conflicts).toEqual([])
  })

  it('still finds a place for the writer’s version when the disk’s blocks are gone', () => {
    const state = conflicted()
    const id = state.conflicts[0]?.blockIds[0] ?? ''
    const gone = run(state, { type: 'delete', ids: [id] })
    const kept = docReducer(gone, {
      type: 'resolve',
      id: state.conflicts[0]?.id ?? '',
      keep: 'mine',
    })
    expect(text(kept)).toBe('One\n\nTwo MINE\n\nThree\n')
  })

  it('ignores a resolve for a conflict that is already settled', () => {
    const state = conflicted()
    expect(docReducer(state, { type: 'resolve', id: 'nope', keep: 'mine' })).toBe(state)
  })

  it('closes an open editor whose block the disk changed too, and keeps its text aside', () => {
    // Both tabs typing in one paragraph used to hand the file back and forth forever (#29's
    // ping-pong): each reload kept the local draft, and the draft was saved again.
    const state = reload(
      run(
        loaded(),
        { type: 'focus', id: 'b2', cursor: 'end' },
        { type: 'draft', id: 'b2', text: 'Two MINE' },
      ),
      'One\n\nTwo DISK\n\nThree\n',
    )
    expect(state.focusedId).toBeNull()
    expect(state.draft).toBeNull()
    expect(liveText(state)).toBe('One\n\nTwo DISK\n\nThree\n')
    expect(state.conflicts[0]).toMatchObject({ mine: 'Two MINE', theirs: 'Two DISK' })
    expect(isDirty(state)).toBe(false)
  })

  it('closes an editor that typed nothing new when the disk changed its block', () => {
    const state = reload(
      run(
        loaded(),
        { type: 'focus', id: 'b2', cursor: 'end' },
        { type: 'draft', id: 'b2', text: 'Two' },
      ),
      'One\n\nTwo DISK\n\nThree\n',
    )
    expect(liveText(state)).toBe('One\n\nTwo DISK\n\nThree\n')
    expect(state.conflicts).toEqual([])
  })

  it('does not call its own save coming back a conflict while the writer typed on', () => {
    const typing = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two MI' },
    )
    const sent = liveText(typing)
    const later = run(
      typing,
      { type: 'sending', text: sent },
      { type: 'draft', id: 'b2', text: 'Two MINE' },
    )
    const state = reload(later, sent)
    expect(state.conflicts).toEqual([])
    expect(state.focusedId).toBe('b2')
    expect(liveText(state)).toBe('One\n\nTwo MINE\n\nThree\n')
  })

  it('undoing a reload brings back what was on screen, the open editor’s text included', () => {
    const typing = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two MINE' },
    )
    const state = reload(typing, 'One\n\nTwo DISK\n\nThree\n')
    expect(text(docReducer(state, { type: 'undo' }))).toBe('One\n\nTwo MINE\n\nThree\n')
  })

  it('keeps an open new block the disk does not have, and the editor on it', () => {
    const open = run(
      loaded('One\n'),
      { type: 'append' },
      { type: 'draft', id: NEW_BLOCK_ID, text: 'Two MINE' },
    )
    const state = reload(open, 'One DISK\n')
    expect(liveText(state)).toBe('One DISK\n\nTwo MINE\n')
    expect(state.draft?.text).toBe('Two MINE')
    expect(state.conflicts).toEqual([])
  })
})

describe('a reload, property', () => {
  const pool = ['One', 'Two', 'Three', 'Same', 'Same', '## Head', '- a\n- b']
  const docText = fc
    .array(fc.constantFrom(...pool), { minLength: 1, maxLength: 5 })
    .map((blocks) => `${blocks.join('\n\n')}\n`)
  const step = fc.oneof(
    fc.record({
      type: fc.constant('edit' as const),
      at: fc.nat(6),
      text: fc.constantFrom('M1', 'M2', ''),
    }),
    fc.record({
      type: fc.constant('type' as const),
      at: fc.nat(6),
      text: fc.constantFrom('D1', 'D2\n\nD3'),
    }),
    fc.record({ type: fc.constant('external' as const), text: docText }),
    fc.record({
      type: fc.constant('resolve' as const),
      keep: fc.constantFrom('mine' as const, 'theirs' as const, 'both' as const),
    }),
    fc.constant({ type: 'blur' as const }),
  )

  it('is exactly the three-way merge of the base, the live text and the disk', () => {
    fc.assert(
      fc.property(docText, fc.array(step, { maxLength: 10 }), (start, steps) => {
        let state = loaded(start)
        let hash = 0
        for (const action of steps) {
          const block = (at: number) => state.doc.blocks[at % Math.max(state.doc.blocks.length, 1)]
          if (action.type === 'edit') {
            const target = block(action.at)
            if (target === undefined) continue
            state = finish(state, target.id, action.text)
          } else if (action.type === 'type') {
            const target = block(action.at)
            if (target === undefined) continue
            state = run(
              state,
              { type: 'focus', id: target.id, cursor: 0 },
              { type: 'draft', id: target.id, text: action.text },
            )
          } else if (action.type === 'external') {
            hash += 1
            const expected = merge3(state.savedText, liveText(state), action.text)
            const before = state.conflicts.length
            state = reload(state, action.text, `h${hash}`)
            expect(liveText(state)).toBe(expected.text)
            expect(state.conflicts.length).toBe(before + expected.conflicts.length)
            expect(state.savedText).toBe(action.text)
          } else if (action.type === 'resolve') {
            const conflict = state.conflicts[0]
            if (conflict === undefined) continue
            state = docReducer(state, { type: 'resolve', id: conflict.id, keep: action.keep })
            if (action.keep === 'mine') expect(liveText(state)).toContain(conflict.mine)
            if (action.keep === 'both') expect(liveText(state)).toContain(conflict.written)
          } else state = docReducer(state, action)
          const ids = state.doc.blocks.map((b) => b.id)
          expect(new Set(ids).size).toBe(ids.length)
          if (state.draft !== null) expect(ids).toContain(state.draft.id)
        }
      }),
      { numRuns: 300, seed: 20260922 },
    )
  })
})
