import { describe, expect, it } from 'vitest'
import { serialise } from '../../shared/blocks/index.ts'
import {
  type DocAction,
  type DocState,
  docReducer,
  initialDocState,
  isDirty,
  liveText,
  NEW_BLOCK_ID,
} from './doc-reducer.ts'

const TEXT = 'A\n\nB\n\nC\n'

function loaded(text = TEXT): DocState {
  return docReducer(initialDocState({ kind: 'article', slug: 'post' }), {
    type: 'loaded',
    text,
    hash: 'h0',
    exists: true,
  })
}
const run = (state: DocState, ...actions: DocAction[]) => actions.reduce(docReducer, state)
const text = (state: DocState) => serialise(state.doc)

describe('editing', () => {
  it('loads clean: not dirty, no history', () => {
    const state = loaded()
    expect(isDirty(state)).toBe(false)
    expect(state.doc.blocks.map((block) => block.id)).toEqual(['b1', 'b2', 'b3'])
  })

  it('the draft of the focused editor is part of the live text before it is committed', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'draft', id: 'b2', text: 'B!' },
    )
    expect(text(state)).toBe(TEXT)
    expect(liveText(state)).toBe('A\n\nB!\n\nC\n')
    expect(isDirty(state)).toBe(true)
  })

  it('commit applies the text, blurs, and is one undo step', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'commit', id: 'b2', text: 'B!' },
    )
    expect(text(state)).toBe('A\n\nB!\n\nC\n')
    expect(state.focusedId).toBeNull()
    expect(text(run(state, { type: 'undo' }))).toBe(TEXT)
    expect(text(run(state, { type: 'undo' }, { type: 'redo' }))).toBe('A\n\nB!\n\nC\n')
  })

  it('an unchanged commit adds no history entry', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'commit', id: 'b2', text: 'B' },
    )
    expect(state.past).toHaveLength(0)
  })

  it('a stale commit from an editor that lost focus is ignored', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b1', cursor: 0 },
      { type: 'commit', id: 'b2', text: 'nope' },
    )
    expect(text(state)).toBe(TEXT)
    expect(state.focusedId).toBe('b1')
  })

  it('re-splits on commit; the first piece keeps the ID', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'commit', id: 'b2', text: 'B1\n\nB2' },
    )
    expect(state.doc.blocks.map((block) => [block.id, block.raw])).toEqual([
      ['b1', 'A'],
      ['b2', 'B1'],
      ['b4', 'B2'],
      ['b3', 'C'],
    ])
  })

  it('emptying a block deletes it', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'commit', id: 'b2', text: '' },
    )
    expect(text(state)).toBe('A\n\nC\n')
  })
})

describe('new blocks', () => {
  it('Enter opens a slot after the current block; committing it inserts a block', () => {
    let state = run(
      loaded(),
      { type: 'focus', id: 'b1', cursor: 'end' },
      { type: 'new-block', currentId: 'b1', currentText: 'A' },
    )
    expect(state.focusedId).toBe(NEW_BLOCK_ID)
    expect(state.pendingNew).toEqual({ afterId: 'b1' })
    state = run(state, { type: 'draft', id: NEW_BLOCK_ID, text: 'New' })
    expect(liveText(state)).toBe('A\n\nNew\n\nB\n\nC\n')
    state = run(state, { type: 'commit', id: NEW_BLOCK_ID, text: 'New' })
    expect(text(state)).toBe('A\n\nNew\n\nB\n\nC\n')
    expect(state.pendingNew).toBeNull()
  })

  it('the slot goes after the last piece when the current block re-splits', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b1', cursor: 'end' },
      {
        type: 'new-block',
        currentId: 'b1',
        currentText: 'A1\n\nA2',
      },
    )
    expect(state.pendingNew?.afterId).toBe(state.doc.blocks[1]?.id)
  })

  it('an empty slot leaves no trace', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b1', cursor: 'end' },
      { type: 'new-block', currentId: 'b1', currentText: 'A' },
      { type: 'commit', id: NEW_BLOCK_ID, text: '  ' },
    )
    expect(text(state)).toBe(TEXT)
    expect(state.past).toHaveLength(0)
  })

  it('append starts the first block of an empty document', () => {
    const state = run(
      loaded(''),
      { type: 'append' },
      { type: 'commit', id: NEW_BLOCK_ID, text: 'Hello' },
    )
    expect(text(state)).toBe('Hello\n')
  })
})

describe('an open new-block slot whose anchor disappears', () => {
  const slotAfter = (state: DocState, id: string, raw: string) =>
    run(
      state,
      { type: 'focus', id, cursor: 'end' },
      { type: 'new-block', currentId: id, currentText: raw },
      { type: 'draft', id: NEW_BLOCK_ID, text: 'my new paragraph' },
    )

  it('stays after the nearest surviving block when an outside reload drops the anchor', () => {
    const state = run(slotAfter(loaded('One\n\nTwo\n\nThree\n'), 'b3', 'Three'), {
      type: 'external',
      text: 'One\n\nTwo\n',
      hash: 'h1',
      exists: true,
    })
    expect(state.pendingNew).toEqual({ afterId: 'b2' })
    expect(liveText(state)).toBe('One\n\nTwo\n\nmy new paragraph\n')
  })

  it('stays in place when an accepted delete removes the anchor (replace-doc)', () => {
    const open = slotAfter(loaded('One\n\nTwo\n\nThree\n'), 'b3', 'Three')
    const without = { blocks: open.doc.blocks.slice(0, 2), gaps: ['', '\n\n', '\n'] }
    const state = run(open, { type: 'replace-doc', doc: without, nextId: open.nextId })
    expect(state.focusedId).toBe(NEW_BLOCK_ID)
    expect(liveText(state)).toBe('One\n\nTwo\n\nmy new paragraph\n')
  })

  it('never jumps above the front matter or to the top of the file', () => {
    const open = slotAfter(loaded('---\ntitle: Post\n---\n\nOne\n\nTwo\n'), 'b3', 'Two')
    const state = run(open, {
      type: 'external',
      text: '---\ntitle: Post\n---\n\nOne\n',
      hash: 'h1',
      exists: true,
    })
    expect(liveText(state)).toBe('---\ntitle: Post\n---\n\nOne\n\nmy new paragraph\n')
  })

  it('falls back to the end, never to index 0, if an anchor is missing anyway', () => {
    const open = slotAfter(loaded('One\n\nTwo\n'), 'b2', 'Two')
    const broken = { ...open, pendingNew: { afterId: 'b999' } }
    expect(liveText(broken)).toBe('One\n\nTwo\n\nmy new paragraph\n')
  })

  it('commits where it was shown', () => {
    const state = run(
      slotAfter(loaded('One\n\nTwo\n\nThree\n'), 'b3', 'Three'),
      { type: 'external', text: 'One\n\nTwo\n', hash: 'h1', exists: true },
      { type: 'commit', id: NEW_BLOCK_ID, text: 'my new paragraph' },
    )
    expect(text(state)).toBe('One\n\nTwo\n\nmy new paragraph\n')
  })
})

describe('navigation and merge', () => {
  it('moves focus to the neighbour and commits on the way', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      {
        type: 'focus-neighbour',
        id: 'b2',
        text: 'B!',
        direction: 1,
      },
    )
    expect(state.focusedId).toBe('b3')
    expect(state.focusCursor).toBe('start')
    expect(text(state)).toBe('A\n\nB!\n\nC\n')
  })

  it('stays put at the edge of the document', () => {
    const focused = run(loaded(), { type: 'focus', id: 'b1', cursor: 0 })
    expect(run(focused, { type: 'focus-neighbour', id: 'b1', text: 'A', direction: -1 })).toBe(
      focused,
    )
  })

  it('Backspace at the start merges into the previous block as one undo step', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'merge-previous', id: 'b2', text: 'B' },
    )
    expect(text(state)).toBe('A\nB\n\nC\n')
    expect(state.focusedId).toBe('b1')
    expect(state.focusCursor).toBe(2)
    expect(text(run(state, { type: 'undo' }))).toBe(TEXT)
  })

  it('Backspace in an empty new slot returns to the block above', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b1', cursor: 'end' },
      { type: 'new-block', currentId: 'b1', currentText: 'A' },
      { type: 'merge-previous', id: NEW_BLOCK_ID, text: '' },
    )
    expect(state.focusedId).toBe('b1')
    expect(state.pendingNew).toBeNull()
  })
})

describe('structure and history', () => {
  it('undo and redo cover reorders', () => {
    const moved = run(loaded(), { type: 'move', from: 2, to: 0 })
    expect(text(moved)).toBe('C\n\nA\n\nB\n')
    expect(text(run(moved, { type: 'undo' }))).toBe(TEXT)
    expect(text(run(moved, { type: 'undo' }, { type: 'redo' }))).toBe('C\n\nA\n\nB\n')
  })

  it('a new change clears the redo stack', () => {
    const state = run(
      loaded(),
      { type: 'move', from: 2, to: 0 },
      { type: 'undo' },
      { type: 'delete', ids: ['b1'] },
    )
    expect(state.future).toEqual([])
  })
})

describe('outside changes', () => {
  it('disk wins, IDs survive, and the reload is an undoable step', () => {
    const state = run(loaded(), {
      type: 'external',
      text: 'A\n\nB from disk\n\nC\n',
      hash: 'h1',
      exists: true,
    })
    expect(state.doc.blocks.map((block) => block.id)).toEqual(['b1', 'b2', 'b3'])
    expect(state.baseHash).toBe('h1')
    expect(isDirty(state)).toBe(false)
    expect(state.past).toHaveLength(1)
  })

  it('the focused block keeps its unsaved text', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'draft', id: 'b2', text: 'B mine' },
      { type: 'external', text: 'A from disk\n\nB\n\nC\n', hash: 'h1', exists: true },
    )
    expect(state.focusedId).toBe('b2')
    expect(liveText(state)).toBe('A from disk\n\nB mine\n\nC\n')
    expect(isDirty(state)).toBe(true)
  })

  it('re-inserts the focused block after its nearest surviving neighbour when disk dropped it', () => {
    const state = run(
      loaded(),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'draft', id: 'b2', text: 'B mine' },
      { type: 'external', text: 'A\n\nC\n', hash: 'h1', exists: true },
    )
    expect(state.doc.blocks.map((block) => block.id)).toEqual(['b1', 'b2', 'b3'])
    expect(liveText(state)).toBe('A\n\nB mine\n\nC\n')
    expect(state.notice).toContain('kept')
  })

  it('ignores an event for the hash it already has', () => {
    const state = loaded()
    expect(run(state, { type: 'external', text: TEXT, hash: 'h0', exists: true })).toBe(state)
  })

  it('a deleted file pauses saving instead of being recreated', () => {
    const state = run(loaded(), { type: 'external', text: '', hash: null, exists: false })
    expect(state.status).toBe('missing')
    expect(isDirty(state)).toBe(false)
  })
})
