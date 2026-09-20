import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { serialise } from '../../shared/blocks/index.ts'
import { SnapshotSchema } from '../../shared/jobs/job-types.ts'
import {
  type DocAction,
  type DocState,
  docReducer,
  initialDocState,
  isDirty,
  liveDoc,
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
/** How many times `needle` occurs in `haystack` — a duplicate is a count, never a substring. */
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

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
    // A reload folds the slot into a real block first, so that the disk's copy of it (when the
    // disk has one) is matched instead of added. The editor moves to that block, and it lands
    // after the anchor's nearest survivor — never at the top of the file.
    expect(liveText(state)).toBe('One\n\nTwo\n\nmy new paragraph\n')
    expect(state.doc.blocks.map((block) => block.raw)).toEqual(['One', 'Two', 'my new paragraph'])
    expect(state.focusedId).toBe(state.doc.blocks[2]?.id)
    expect(state.pendingNew).toBeNull()
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
    // `blur` commits whatever the editor holds, wherever the reload left it — addressing the
    // slot by name would now be a no-op, and a test that asserts nothing is worse than none.
    const state = run(
      slotAfter(loaded('One\n\nTwo\n\nThree\n'), 'b3', 'Three'),
      { type: 'external', text: 'One\n\nTwo\n', hash: 'h1', exists: true },
      { type: 'blur' },
    )
    expect(text(state)).toBe('One\n\nTwo\n\nmy new paragraph\n')
    expect(state.doc.blocks).toHaveLength(3)
  })
})

describe('a reload that carries the editor’s own text', () => {
  // Autosave writes `liveText`, which includes whatever the open editor holds. When that same
  // text comes back as an `external` — an SSE event from another writer, the re-check on
  // reconnect, or the body of a 409 — the reload must not add what the editor is still holding.
  const typedAfter = (state: DocState, id: string, raw: string, typed: string) =>
    run(
      state,
      { type: 'focus', id, cursor: 'end' },
      { type: 'new-block', currentId: id, currentText: raw },
      { type: 'draft', id: NEW_BLOCK_ID, text: typed },
    )
  const reload = (state: DocState, disk: string): DocState =>
    docReducer(state, { type: 'external', text: disk, hash: 'h1', exists: true })

  it('does not duplicate the new block the autosave already wrote', () => {
    const open = typedAfter(loaded('One\n\nTwo\n'), 'b2', 'Two', 'Three')
    const state = reload(open, liveText(open))
    expect(liveText(state)).toBe('One\n\nTwo\n\nThree\n')
    // Committing what is on screen writes the same thing: once in the store, once on disk.
    const committed = docReducer(state, { type: 'blur' })
    expect(text(committed)).toBe('One\n\nTwo\n\nThree\n')
    expect(committed.doc.blocks.map((block) => block.raw)).toEqual(['One', 'Two', 'Three'])
  })

  it('keeps the keystrokes typed while the save was in flight', () => {
    const open = typedAfter(loaded('One\n\nTwo\n'), 'b2', 'Two', 'Three')
    const inFlight = liveText(open) // what the PUT carried
    const typing = docReducer(open, { type: 'draft', id: NEW_BLOCK_ID, text: 'Threex' })
    expect(liveText(reload(typing, inFlight))).toBe('One\n\nTwo\n\nThreex\n')
  })

  it('does not duplicate an appended block', () => {
    const open = run(
      loaded('Base\n'),
      { type: 'append' },
      { type: 'draft', id: NEW_BLOCK_ID, text: 'Appended' },
    )
    expect(liveText(reload(open, liveText(open)))).toBe('Base\n\nAppended\n')
  })

  it('keeps an outside change and the new block, each exactly once', () => {
    const open = typedAfter(loaded('One\n\nTwo\n'), 'b2', 'Two', 'Three')
    const state = reload(open, 'One\n\nTwo\n\nThree\n\nOUTSIDE\n')
    expect(liveText(state)).toBe('One\n\nTwo\n\nThree\n\nOUTSIDE\n')
  })

  it('does not duplicate a slot holding several blocks', () => {
    const open = typedAfter(loaded('One\n\nTwo\n'), 'b2', 'Two', 'Three\n\n## Four')
    expect(liveText(reload(open, liveText(open)))).toBe('One\n\nTwo\n\nThree\n\n## Four\n')
  })

  it('keeps a slot that grew past what the save carried', () => {
    const open = typedAfter(loaded('One\n\nTwo\n'), 'b2', 'Two', 'Three')
    const saved = liveText(open)
    const grown = docReducer(open, { type: 'draft', id: NEW_BLOCK_ID, text: 'Three\n\nFour' })
    expect(liveText(reload(grown, saved))).toBe('One\n\nTwo\n\nThree\n\nFour\n')
  })

  it('does not duplicate the tail of a draft that spans several blocks', () => {
    const open = run(
      loaded('One\n\nTwo\n\nThree\n'),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two EDITED\n\n## Heading' },
    )
    expect(liveText(reload(open, liveText(open)))).toBe(
      'One\n\nTwo EDITED\n\n## Heading\n\nThree\n',
    )
  })

  it('keeps a folded tail whose ID a changed block from disk inherited', () => {
    // `reconcile` gives the first slice of a changed run the old ID of that run, so the block
    // answering to the folded tail's ID afterwards can be a different one, from disk. Checking
    // the ID alone said the tail had survived, and it was dropped without a word.
    const open = run(
      loaded('One\n\nTwo\n\nThree\n\nFour\n'),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two EDITED\n\n## Heading' },
    )
    const state = reload(open, 'One\n\nTwo\n\nThree CHANGED\n\nFour\n')
    expect(liveText(state)).toBe('One\n\nTwo EDITED\n\n## Heading\n\nThree CHANGED\n\nFour\n')
    const ids = state.doc.blocks.map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps a folded tail the disk dropped, when a later block also changed', () => {
    const open = run(
      loaded('One\n\nTwo\n\nThree\n'),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two EDITED\n\n## Heading' },
    )
    const state = reload(open, 'One\n\nTwo\n\nThree CHANGED\n')
    expect(liveText(state)).toBe('One\n\nTwo EDITED\n\n## Heading\n\nThree CHANGED\n')
  })

  it('still lets the disk win where the editor is not, and keeps the editor’s block', () => {
    // The behaviours the fix must not disturb, from the other side of the same code path.
    const editing = run(
      loaded('One\n\nTwo\n\nThree\n'),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two UNSAVED' },
    )
    expect(liveText(reload(editing, 'One CHANGED\n\nTwo\n\nThree\n'))).toBe(
      'One CHANGED\n\nTwo UNSAVED\n\nThree\n',
    )
    const vanished = reload(editing, 'One\n\nThree\n')
    expect(liveText(vanished)).toBe('One\n\nTwo UNSAVED\n\nThree\n')
    expect(vanished.notice).toContain('was kept')
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

  it('ignores a save that lands after a reload moved the document on', () => {
    // The PUT left while the document was based on h0; the reload landed before it came back.
    const reloaded = run(loaded('One\n\nTwo\n'), {
      type: 'external',
      text: 'One\n\nTwo CHANGED\n',
      hash: 'h1',
      exists: true,
    })
    const late = run(reloaded, {
      type: 'saved',
      text: 'One\n\nTwo\n',
      hash: 'h-of-the-older-text',
      baseHash: 'h0',
    })
    expect(late).toBe(reloaded)
    expect(late.baseHash).toBe('h1')
    expect(late.savedText).toBe('One\n\nTwo CHANGED\n')
  })

  it('accepts a save the document is still waiting for', () => {
    const state = run(loaded('One\n\nTwo\n'), {
      type: 'saved',
      text: 'One\n\nTwo\n',
      hash: 'h1',
      baseHash: 'h0',
    })
    expect(state.baseHash).toBe('h1')
    expect(state.savedText).toBe('One\n\nTwo\n')
    expect(isDirty(state)).toBe(false)
  })

  it('gives a job snapshot only block IDs the job contract accepts', () => {
    // `liveDoc` is what `postNow` sends as a job's snapshot, and `SnapshotSchema` binds every
    // block ID to `BlockIdSchema`. An ID shape the schema rejects makes the request a 400, so
    // starting a job while the editor is open fails and the writer only sees "Could not start".
    const open = run(
      loaded('One\n\nTwo\n'),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'new-block', currentId: 'b2', currentText: 'Two' },
      { type: 'draft', id: NEW_BLOCK_ID, text: 'Three' },
    )
    const appended = run(
      loaded('One\n'),
      { type: 'append' },
      { type: 'draft', id: NEW_BLOCK_ID, text: 'Appended' },
    )
    const splitting = run(
      loaded('One\n\nTwo\n'),
      { type: 'focus', id: 'b2', cursor: 'end' },
      { type: 'draft', id: 'b2', text: 'Two\n\n## Heading' },
    )
    for (const state of [open, appended, splitting, loaded()]) {
      const { blocks, gaps } = liveDoc(state)
      expect(SnapshotSchema.safeParse({ blocks, gaps }).success).toBe(true)
    }
  })

  it('a deleted file pauses saving instead of being recreated', () => {
    const state = run(loaded(), { type: 'external', text: '', hash: null, exists: false })
    expect(state.status).toBe('missing')
    expect(isDirty(state)).toBe(false)
  })
})

describe('an open editor never loses its block', () => {
  const editing = () =>
    run(
      loaded('A\n\nB\n\nC\n\nD\n'),
      { type: 'focus', id: 'b2', cursor: 0 },
      { type: 'draft', id: 'b2', text: 'B typed by the writer' },
    )
  // Neither the open editor nor its draft may point at a block that is not in the document.
  const dangling = (state: DocState) =>
    [state.focusedId, state.draft?.id ?? null].some(
      (id) =>
        id !== null && id !== NEW_BLOCK_ID && !state.doc.blocks.some((block) => block.id === id),
    )

  it('an accepted op that swallows the focused block keeps the editor text, in place', () => {
    const before = editing()
    // What applyOps produces for a replace of b1 that opens a code fence and never closes it.
    const swallowed = run(loaded('A2\n\n```js\nconst x = 1\n\nB\n\nC\n\nD\n')).doc
    expect(swallowed.blocks).toHaveLength(2)
    const doc = {
      ...swallowed,
      blocks: swallowed.blocks.map((b, i) => ({ ...b, id: `b${i + 7}` })),
    }
    const after = docReducer(before, { type: 'replace-doc', doc, nextId: 20 })

    expect(dangling(after)).toBe(false)
    expect(after.focusedId).toBe('b2')
    expect(after.doc.blocks.map((block) => block.id)[0]).toBe('b2')
    expect(liveText(after)).toContain('B typed by the writer')
    expect(after.notice).toContain('Your text was kept')
    // Blur keeps it, and one undo takes the whole accepted change back.
    expect(text(docReducer(after, { type: 'blur' }))).toContain('B typed by the writer')
    expect(text(run(after, { type: 'blur' }, { type: 'undo' }, { type: 'undo' }))).toBe(
      'A\n\nB\n\nC\n\nD\n',
    )
  })

  it('deleting the block that is being edited closes the editor, and a later reload does not bring it back', () => {
    const deleted = docReducer(editing(), { type: 'delete', ids: ['b2'] })
    expect(deleted.draft).toBeNull()
    expect(deleted.focusedId).toBeNull()
    const reloaded = docReducer(deleted, {
      type: 'external',
      text: 'A\n\nC\n\nD\n\nE\n',
      hash: 'h1',
      exists: true,
    })
    expect(text(reloaded)).toBe('A\n\nC\n\nD\n\nE\n')
  })

  it('keeps the editor’s text once when a fence from disk swallows its block', () => {
    // The rescue puts the text back, but an unclosed fence arriving from disk swallows it, so
    // no block carries the draft's ID afterwards — and the rescue used to run a second time.
    const state = run(
      loaded('A\n\nB\n\nC\n\nD\n'),
      { type: 'focus', id: 'b3', cursor: 0 },
      { type: 'draft', id: 'b3', text: 'typed' },
      { type: 'external', text: '```js\nnever closed\n\nB\n', hash: 'h1', exists: true },
    )
    expect(occurrences(liveText(state), 'typed')).toBe(1)
    expect(dangling(state)).toBe(false)
  })

  it('follows its text, not the first block, when the draft ends in whitespace', () => {
    // `splitText` trims a block's trailing whitespace into the gap after it, so looking for the
    // untrimmed draft found nothing and the editor was reopened on the top of the article.
    const state = run(
      loaded('A\n\nB\n\nC\n\nD\n'),
      { type: 'focus', id: 'b3', cursor: 0 },
      { type: 'draft', id: 'b3', text: 'typed with trailing spaces   ' },
      { type: 'external', text: 'A\n\n```js\nnever closed', hash: 'h1', exists: true },
    )
    expect(liveText(state)).toContain('typed with trailing spaces')
    expect(state.draft?.text).toContain('typed with trailing spaces')
    expect(state.focusedId).not.toBe('b1')
    expect(dangling(state)).toBe(false)
  })

  it('emptying the focused block and leaving it still deletes it', () => {
    const state = run(editing(), { type: 'draft', id: 'b2', text: '' }, { type: 'blur' })
    expect(text(state)).toBe('A\n\nC\n\nD\n')
  })

  it('holds for any sequence of structural changes', () => {
    const fence = '```js\nnever closed'
    const step = fc.oneof(
      fc.record({
        type: fc.constant('focus' as const),
        id: fc.constantFrom('b1', 'b2', 'b3', 'b4'),
        cursor: fc.constant(0),
      }),
      // The focused editor reports its text; which block that is depends on the state.
      fc.record({
        type: fc.constant('type' as const),
        text: fc.constantFrom('typed', 'typed\n\ntwice', fence),
      }),
      fc.record({
        type: fc.constant('insert' as const),
        index: fc.nat(4),
        markdown: fc.constantFrom('new', fence, '{{< note >}}'),
      }),
      fc.record({ type: fc.constant('move' as const), from: fc.nat(3), to: fc.nat(3) }),
      fc.record({
        type: fc.constant('delete' as const),
        ids: fc.subarray(['b1', 'b2', 'b3', 'b4']),
      }),
      fc.record({
        type: fc.constant('external' as const),
        text: fc.constantFrom('A\n\nC\n', `${fence}\n\nB\n`, 'X\n\nB\n\nY\n'),
        hash: fc.string({ minLength: 1, maxLength: 4 }),
        exists: fc.constant(true),
      }),
      // What accepting a proposal dispatches: a whole new document, here with every ID changed.
      fc
        .constantFrom('A\n\nC\n', `A\n\n${fence}\n\nB\n\nC\n`, 'A\n\nB2\n\nC\n\nD\n')
        .map((replaced) => ({
          type: 'replace-doc' as const,
          doc: {
            ...loaded(replaced).doc,
            blocks: loaded(replaced).doc.blocks.map((block, i) => ({ ...block, id: `b${i + 90}` })),
          },
          nextId: 99,
        })),
      // Enter at the end of a block, and the append button: both open the editor slot.
      fc.record({
        type: fc.constant('new-block' as const),
        currentId: fc.constantFrom('b1', 'b2', 'b3', 'b4'),
      }),
      fc.constant({ type: 'append' as const }),
      // The reload that carries what this client itself last saved — the open editor included.
      fc.constant({ type: 'reload-own-save' as const }),
      fc.constant({ type: 'blur' as const }),
      fc.constant({ type: 'undo' as const }),
    )
    fc.assert(
      fc.property(fc.array(step, { maxLength: 12 }), (steps) => {
        let state = loaded('A\n\nB\n\nC\n\nD\n')
        let hash = 0
        for (const action of steps) {
          if (action.type === 'focus' && !state.doc.blocks.some((block) => block.id === action.id))
            continue
          if (action.type === 'type') {
            // The slot types too: its text is exactly the text that used to come back doubled.
            if (state.focusedId === null) continue
            state = docReducer(state, { type: 'draft', id: state.focusedId, text: action.text })
          } else if (action.type === 'new-block') {
            const current = state.doc.blocks.find((block) => block.id === action.currentId)
            if (current === undefined) continue
            state = run(
              state,
              { type: 'focus', id: current.id, cursor: 0 },
              { type: 'new-block', currentId: current.id, currentText: current.raw },
            )
          } else if (action.type === 'reload-own-save') {
            hash += 1
            const saved = liveText(state)
            state = docReducer(state, {
              type: 'external',
              text: saved,
              hash: `saved-${hash}`,
              exists: true,
            })
            // The heart of it: autosave writes the live text, editor included, so a reload that
            // carries that same text must leave the document exactly as it was. When it does
            // not, whatever the editor holds has been added a second time.
            //
            // The exception is an unclosed fence still being typed: it swallows the blocks
            // after it, so the block the reload produces holds strictly more than the editor
            // does, and the next save would drop the rest. That is a defect of its own, with
            // its own follow-up — whose text wins there is a judgement call, not a duplicate.
            const open = state.doc.blocks.find((block) => block.id === state.draft?.id)
            const swallowed =
              open !== undefined &&
              state.draft !== null &&
              open.raw !== state.draft.text &&
              open.raw.includes(state.draft.text)
            if (!swallowed) expect(liveText(state)).toBe(saved)
          } else {
            state = docReducer(state, action as DocAction)
          }
          expect(dangling(state)).toBe(false)
          if (state.draft !== null && state.draft.text.trim() !== '')
            expect(liveText(state)).toContain(state.draft.text)
        }
      }),
      { numRuns: 300, seed: 20260919 },
    )
  })
})
