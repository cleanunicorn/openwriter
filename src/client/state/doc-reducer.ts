import type { DocRef } from '../../shared/api-types.ts'
import {
  type Block,
  createDoc,
  type Doc,
  deleteBlocks,
  insertMarkdown,
  type MintId,
  mergeWithPrevious,
  moveBlock,
  reconcile,
  replaceBlock,
  serialise,
  splitText,
} from '../../shared/blocks/index.ts'

/** ID of the editor slot for a block that does not exist yet (Enter on an empty last line). */
export const NEW_BLOCK_ID = 'new'

export type Draft = { id: string; text: string }
export type PendingNew = { afterId: string | null }
export type FocusCursor = number | 'start' | 'end'

export type DocState = {
  ref: DocRef
  status: 'loading' | 'ready' | 'error' | 'missing'
  error: string | null
  doc: Doc
  nextId: number
  /** Document-level undo: snapshots of `Doc`, structurally shared. */
  past: Doc[]
  future: Doc[]
  /** Disk hash the live document is based on, and the text last loaded or saved. */
  baseHash: string | null
  savedText: string
  focusedId: string | null
  focusCursor: FocusCursor
  /** Live text of the focused editor; part of every save and every job snapshot. */
  draft: Draft | null
  pendingNew: PendingNew | null
  selectedIds: string[]
  notice: string | null
}

export type DocAction =
  | { type: 'loaded'; text: string; hash: string | null; exists: boolean }
  | { type: 'failed'; error: string }
  | { type: 'focus'; id: string; cursor: FocusCursor }
  | { type: 'draft'; id: string; text: string }
  | { type: 'commit'; id: string; text: string }
  | { type: 'blur' }
  | { type: 'append' }
  | { type: 'new-block'; currentId: string; currentText: string }
  | { type: 'merge-previous'; id: string; text: string }
  | { type: 'focus-neighbour'; id: string; text: string; direction: -1 | 1 }
  | { type: 'move'; from: number; to: number }
  | { type: 'insert'; index: number; markdown: string }
  | { type: 'delete'; ids: string[] }
  | { type: 'replace-doc'; doc: Doc; nextId: number }
  | { type: 'select'; ids: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'saved'; text: string; hash: string; baseHash: string | null }
  | { type: 'external'; text: string; hash: string | null; exists: boolean }
  | { type: 'notice'; notice: string | null }

const HISTORY_LIMIT = 200

export function initialDocState(ref: DocRef): DocState {
  return {
    ref,
    status: 'loading',
    error: null,
    doc: { blocks: [], gaps: [''] },
    nextId: 1,
    past: [],
    future: [],
    baseHash: null,
    savedText: '',
    focusedId: null,
    focusCursor: 'end',
    draft: null,
    pendingNew: null,
    selectedIds: [],
    notice: null,
  }
}

/** A minter that continues the document's counter, so reducers stay pure. */
function minter(state: DocState): { mint: MintId; next: () => number } {
  let next = state.nextId
  return { mint: () => `b${next++}`, next: () => next }
}

const indexOf = (doc: Doc, id: string) => doc.blocks.findIndex((block) => block.id === id)

/**
 * The anchor of an open new-block slot, carried over to `next`: the anchor itself when it
 * survives, otherwise its nearest surviving predecessor (null = top of the document). Without
 * this, a slot whose anchor was deleted or reloaded away would land at index 0 and autosave
 * would write the paragraph the writer typed at the end of the article to the top of the file.
 */
function reanchor(previous: Doc, next: Doc, pending: PendingNew | null): PendingNew | null {
  if (pending === null || pending.afterId === null) return pending
  if (indexOf(next, pending.afterId) !== -1) return pending
  const oldIndex = indexOf(previous, pending.afterId)
  const survivor = previous.blocks
    .slice(0, Math.max(oldIndex, 0))
    .reverse()
    .find((block) => indexOf(next, block.id) !== -1)
  return { afterId: survivor?.id ?? null }
}

/**
 * The focused block vanished on disk: put its editor text back into `disk` after its nearest
 * surviving neighbour, so the open editor still points at a block. Returns the ID of the block
 * that now holds the text — its old one normally, but the insert can land inside a block that
 * was already there (an unclosed fence arriving from disk swallows whatever follows it), and
 * then the editor follows its text rather than the caller putting it back a second time.
 */
function keepFocusedBlock(
  previous: Doc,
  disk: Doc,
  draft: Draft,
  mint: MintId,
): { doc: Doc; id: string } {
  // `previous` always has the block: `change()` never lets an open draft lose its block.
  const oldIndex = indexOf(previous, draft.id)
  const survivor = previous.blocks
    .slice(0, oldIndex)
    .reverse()
    .find((block: Block) => indexOf(disk, block.id) !== -1)
  const at = survivor === undefined ? 0 : indexOf(disk, survivor.id) + 1
  const known = new Set(disk.blocks.map((block) => block.id))
  const text = draft.text.trim() === '' ? '…' : draft.text
  const inserted = insertMarkdown(disk, at, text, mint)
  const fresh = inserted.blocks.find((block) => !known.has(block.id))
  if (fresh !== undefined) {
    // The old ID goes back on only while it is free. A block from disk can already answer to
    // it — `reconcile` hands the first slice of a changed run the old ID of that run — and two
    // blocks with one ID would break every lookup that follows.
    if (known.has(draft.id)) return { doc: inserted, id: fresh.id }
    return {
      doc: {
        ...inserted,
        blocks: inserted.blocks.map((block) =>
          block === fresh ? { ...block, id: draft.id } : block,
        ),
      },
      id: draft.id,
    }
  }
  const holder =
    inserted.blocks.find((block) => block.raw.includes(text)) ??
    inserted.blocks[at] ??
    disk.blocks[0]
  return { doc: inserted, id: holder?.id ?? draft.id }
}

/**
 * Index at which the open slot's text goes. A null anchor is the top of the document; an anchor
 * that is no longer in the document means the end, never index 0.
 */
function slotIndex(doc: Doc, pending: PendingNew | null): number {
  if (pending === null) return doc.blocks.length
  if (pending.afterId === null) return 0
  const index = indexOf(doc, pending.afterId)
  return index === -1 ? doc.blocks.length : index + 1
}

/** Apply a structural change as one undoable step. */
function change(
  state: DocState,
  doc: Doc,
  nextId: number,
  extra: Partial<DocState> = {},
): DocState {
  if (doc === state.doc) return { ...state, ...extra }
  // Every structural change passes through here, so this is where the invariant is kept: the
  // block of an open editor is in the document. A change can take it away without touching it —
  // an accepted op that opens a code fence swallows the blocks after it — and then the draft would
  // drop out of the live text and be lost on blur. `state.doc` still has the block, so its place
  // is known.
  const draft = state.draft
  let rescued: Partial<DocState> = {}
  if (draft !== null && draft.id !== NEW_BLOCK_ID && indexOf(doc, draft.id) === -1) {
    const { mint, next } = minter({ ...state, nextId })
    const rescue = keepFocusedBlock(state.doc, doc, draft, mint)
    doc = rescue.doc
    nextId = next()
    rescued = { notice: 'A change replaced the block you are editing. Your text was kept.' }
    if (rescue.id !== draft.id) {
      const holder = doc.blocks[indexOf(doc, rescue.id)]
      rescued = {
        ...rescued,
        focusedId: rescue.id,
        draft: { id: rescue.id, text: holder?.raw ?? draft.text },
      }
    }
  } else if (
    state.focusedId !== null &&
    state.focusedId !== NEW_BLOCK_ID &&
    indexOf(doc, state.focusedId) === -1
  ) {
    // Nothing was typed, so there is nothing to keep: the editor of a block that is gone closes.
    rescued = { focusedId: null }
  }
  return {
    ...state,
    pendingNew: reanchor(state.doc, doc, state.pendingNew),
    ...rescued,
    ...extra,
    doc,
    nextId,
    past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
    future: [],
  }
}

/**
 * IDs for blocks that exist only in a derived document — the open editor's text folded in for a
 * save, a job snapshot or an export. The store never mints these, so an op that comes back aimed
 * at one is recognised as missing and withdrawn, instead of landing on whatever block the store
 * later gave that ID to.
 */
function derivedMinter(): MintId {
  let next = 1
  return () => `live${next++}`
}

/**
 * Fold the focused editor's text into the document without touching history. `derived` mints the
 * IDs when the result is not going to be stored; without it the document's own counter is used.
 */
function withDraft(
  state: DocState,
  id: string,
  text: string,
  derived?: MintId,
): { doc: Doc; nextId: number } {
  const { mint: stored, next } = minter(state)
  const mint = derived ?? stored
  if (id === NEW_BLOCK_ID) {
    if (text.trim() === '' || state.pendingNew === null)
      return { doc: state.doc, nextId: state.nextId }
    const index = slotIndex(state.doc, state.pendingNew)
    return { doc: insertMarkdown(state.doc, index, text, mint), nextId: next() }
  }
  const index = indexOf(state.doc, id)
  const block = state.doc.blocks[index]
  if (block === undefined || block.raw === text) return { doc: state.doc, nextId: state.nextId }
  return { doc: replaceBlock(state.doc, index, text, mint), nextId: next() }
}

/**
 * Fold into the document what the open editor holds but the document does not have yet: the
 * whole text of a new-block slot, or the tail blocks of a draft that spans several. Both are
 * already in the text autosave wrote, so a reload carrying that text would bring them back a
 * second time. Returns the IDs the draft now occupies, the one the editor keeps first.
 *
 * A draft's own block is deliberately left as it is: rewriting its raw would cost it the
 * identity `reconcile` needs to match the disk's older copy of it instead of adding one.
 */
function foldDraft(
  state: DocState,
  draft: Draft,
): { doc: Doc; nextId: number; ids: string[]; held: Draft } | null {
  const { slices, gaps } = splitText(draft.text)
  if (draft.id !== NEW_BLOCK_ID && slices.length < 2) return null
  const known = new Set(state.doc.blocks.map((block) => block.id))
  const { mint, next } = minter(state)
  let doc: Doc
  let at: number
  if (draft.id === NEW_BLOCK_ID) {
    if (draft.text.trim() === '' || state.pendingNew === null) return null
    at = slotIndex(state.doc, state.pendingNew)
    doc = insertMarkdown(state.doc, at, draft.text, mint)
  } else {
    const index = indexOf(state.doc, draft.id)
    if (index === -1) return null
    const tail = serialise({ blocks: slices.slice(1), gaps: ['', ...gaps.slice(2)] })
    at = index
    doc = insertMarkdown(state.doc, index + 1, tail, mint)
  }
  if (doc === state.doc) return null
  const fresh = doc.blocks.filter((block) => !known.has(block.id)).map((block) => block.id)
  // Which block the editor goes on, and what it holds there. Taking the text from the folded
  // document rather than from the reconciled one matters: the disk's copy can be a keystroke
  // behind the keyboard. Folding nothing new means the text landed inside a block that was
  // already there — an unclosed fence swallows whatever follows it — and the editor holds that
  // block whole, because that is what the document now has.
  const ids = draft.id === NEW_BLOCK_ID ? fresh : [draft.id, ...fresh]
  const heldId =
    ids[0] ??
    doc.blocks.find((block) => block.raw.includes(draft.text))?.id ??
    doc.blocks[Math.min(at, doc.blocks.length - 1)]?.id
  if (heldId === undefined) return null
  const block = doc.blocks[indexOf(doc, heldId)]
  if (block === undefined) return null
  // A draft's own block still carries the raw it had: only its tail was folded in, so the
  // editor keeps the first block of what the writer typed.
  const ownBlockKeptItsText = draft.id !== NEW_BLOCK_ID && fresh.length > 0
  const text = ownBlockKeptItsText ? (slices[0]?.raw ?? draft.text) : block.raw
  return { doc, nextId: next(), ids: ids.length > 0 ? ids : [heldId], held: { id: heldId, text } }
}

/** The document as the writer sees it right now: committed blocks plus the open editor's text. */
export function liveDoc(state: DocState): Doc {
  if (state.draft === null) return state.doc
  return withDraft(state, state.draft.id, state.draft.text, derivedMinter()).doc
}

export const liveText = (state: DocState): string => serialise(liveDoc(state))
export const isDirty = (state: DocState): boolean =>
  state.status === 'ready' && liveText(state) !== state.savedText

/** How many blocks sit before and after an editor slot; stable across a commit of that slot. */
function position(state: DocState, id: string): { before: number; tail: number } {
  const length = state.doc.blocks.length
  if (id === NEW_BLOCK_ID) {
    const before = slotIndex(state.doc, state.pendingNew)
    return { before, tail: length - before }
  }
  const index = indexOf(state.doc, id)
  return { before: index, tail: length - 1 - index }
}

const blurred = { focusedId: null, draft: null, pendingNew: null } satisfies Partial<DocState>

function commit(state: DocState, id: string, text: string): DocState {
  const { doc, nextId } = withDraft(state, id, text)
  // The draft is what is being folded in: its block may legitimately split, merge or vanish.
  return change({ ...state, draft: null }, doc, nextId, blurred)
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case 'loaded': {
      // A brief or strategy that was never written is an empty document, created on first save.
      if (!action.exists && state.ref.kind === 'article')
        return { ...state, status: 'missing', error: null }
      const { mint, next } = minter({ ...state, nextId: 1 })
      const doc = createDoc(action.text, mint)
      return {
        ...initialDocState(state.ref),
        status: 'ready',
        doc,
        nextId: next(),
        baseHash: action.hash,
        savedText: action.text,
      }
    }
    case 'failed':
      return { ...state, status: 'error', error: action.error }
    case 'focus':
      return {
        ...state,
        focusedId: action.id,
        focusCursor: action.cursor,
        draft: null,
        selectedIds: [],
      }
    case 'draft':
      return state.focusedId === action.id
        ? { ...state, draft: { id: action.id, text: action.text } }
        : state
    case 'commit': {
      if (state.focusedId !== action.id) return state
      return commit(state, action.id, action.text)
    }
    case 'blur':
      return state.draft === null
        ? { ...state, ...blurred }
        : commit(state, state.draft.id, state.draft.text)
    case 'append': {
      const committed = docReducer(state, { type: 'blur' })
      const afterId = committed.doc.blocks[committed.doc.blocks.length - 1]?.id ?? null
      return {
        ...committed,
        focusedId: NEW_BLOCK_ID,
        focusCursor: 'start',
        pendingNew: { afterId },
      }
    }
    case 'new-block': {
      const { tail } = position(state, action.currentId)
      const committed = commit(state, action.currentId, action.currentText)
      // The current block may have re-split: the new slot goes after its last piece.
      const afterId = committed.doc.blocks[committed.doc.blocks.length - 1 - tail]?.id ?? null
      return {
        ...committed,
        focusedId: NEW_BLOCK_ID,
        focusCursor: 'start',
        pendingNew: { afterId },
      }
    }
    case 'merge-previous': {
      if (action.id === NEW_BLOCK_ID) {
        const afterId = state.pendingNew?.afterId ?? null
        return { ...state, ...blurred, focusedId: afterId, focusCursor: 'end' }
      }
      const committed = commit(state, action.id, action.text)
      const index = indexOf(committed.doc, action.id)
      if (index <= 0) return { ...committed, focusedId: action.id, focusCursor: 'start' }
      const { mint, next } = minter(committed)
      const merged = mergeWithPrevious(committed.doc, index, mint)
      if (merged === null) return { ...committed, focusedId: action.id, focusCursor: 'start' }
      // One undo step for the whole gesture: drop the intermediate commit entry if there was one.
      const base =
        committed.doc === state.doc ? committed : { ...committed, past: state.past, doc: state.doc }
      return change(base, merged.doc, next(), {
        focusedId: merged.focusId,
        focusCursor: merged.cursor,
      })
    }
    case 'focus-neighbour': {
      const { before, tail } = position(state, action.id)
      const committed = commit(state, action.id, action.text)
      const index = action.direction === -1 ? before - 1 : committed.doc.blocks.length - tail
      const target = committed.doc.blocks[index]
      if (target === undefined) return state
      return {
        ...committed,
        focusedId: target.id,
        focusCursor: action.direction === 1 ? 'start' : 'end',
      }
    }
    case 'move': {
      const { mint, next } = minter(state)
      return change(state, moveBlock(state.doc, action.from, action.to, mint), next())
    }
    case 'insert': {
      const { mint, next } = minter(state)
      return change(state, insertMarkdown(state.doc, action.index, action.markdown, mint), next())
    }
    case 'delete': {
      const { mint, next } = minter(state)
      const indices = action.ids.map((id) => indexOf(state.doc, id)).filter((index) => index >= 0)
      // Deleting the block that is being edited closes its editor; it is not rescued.
      const closing = state.draft !== null && action.ids.includes(state.draft.id)
      const from = closing ? { ...state, ...blurred } : state
      return change(from, deleteBlocks(state.doc, indices, mint), next(), { selectedIds: [] })
    }
    case 'replace-doc':
      return change(state, action.doc, action.nextId)
    case 'select':
      return { ...state, selectedIds: action.ids }
    case 'undo': {
      const previous = state.past[state.past.length - 1]
      if (previous === undefined) return state
      return {
        ...state,
        ...blurred,
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
      }
    }
    case 'redo': {
      const [next, ...rest] = state.future
      if (next === undefined) return state
      return { ...state, ...blurred, doc: next, past: [...state.past, state.doc], future: rest }
    }
    case 'saved':
      // A save that resolves after a reload moved the document on is one revision behind: its
      // hash would roll `baseHash` back, and the next PUT would be a guaranteed 409.
      if (action.baseHash !== state.baseHash) return state
      return { ...state, baseHash: action.hash, savedText: action.text }
    case 'external': {
      if (!action.exists) {
        return {
          ...state,
          status: 'missing',
          notice: 'This file was deleted on disk. Autosave is paused.',
        }
      }
      if (action.hash === state.baseHash) return state
      const draft = state.draft
      // What the editor holds is already in the file autosave wrote. Reconciling against
      // `state.doc`, which does not have it yet, would bring it back from disk *and* leave the
      // editor holding it: the writer's paragraph twice. Fold it in first, so the reconcile
      // matches the disk's copy with it instead of adding one.
      const folded = draft === null ? null : foldDraft(state, draft)
      const base = folded?.doc ?? state.doc
      const { mint, next } = minter({ ...state, nextId: folded?.nextId ?? state.nextId })
      let doc = reconcile(base, action.text, mint)
      let notice: string | null = 'Reloaded: the file changed on disk.'
      let reopened: Partial<DocState> = {}
      // Disk wins everywhere except what the writer is editing, which keeps its text.
      if (folded !== null && draft !== null) {
        const settled = folded.ids.map((id) => {
          const block = base.blocks[indexOf(base, id)]
          if (block === undefined) return id
          // The block the editor keeps is re-applied from its draft, so it only has to exist.
          // The rest of the fold lives in the document alone, and an ID is not enough to find
          // it: `reconcile` gives the first slice of a changed run the old ID of that run, so a
          // block still answering to one of these IDs can be a different one, from disk. Look
          // for the text itself — if it is gone, the writer's tail went with it.
          const survivor =
            id === folded.held.id
              ? doc.blocks[indexOf(doc, id)]
              : doc.blocks.find((candidate) => candidate.raw === block.raw)
          if (survivor !== undefined) return survivor.id
          const rescue = keepFocusedBlock(base, doc, { id, text: block.raw }, mint)
          doc = rescue.doc
          notice = 'The file changed on disk. The block you are editing was kept.'
          return rescue.id
        })
        // The editor keeps what it held, with the writer's own text: the raw the reconcile
        // produced would be the disk's copy, one save behind the keyboard. A rescue that fused
        // the text into another block moves the editor there instead.
        const moved = settled[folded.ids.indexOf(folded.held.id)] ?? folded.held.id
        const held =
          moved === folded.held.id
            ? folded.held
            : { id: moved, text: doc.blocks[indexOf(doc, moved)]?.raw ?? folded.held.text }
        reopened = { draft: held, focusedId: held.id, focusCursor: 'end', pendingNew: null }
      } else if (draft !== null && draft.id !== NEW_BLOCK_ID && indexOf(doc, draft.id) === -1) {
        const rescue = keepFocusedBlock(state.doc, doc, draft, mint)
        doc = rescue.doc
        notice = 'The file changed on disk. The block you are editing was kept.'
        if (rescue.id !== draft.id) {
          const holder = doc.blocks[indexOf(doc, rescue.id)]
          reopened = {
            draft: { id: rescue.id, text: holder?.raw ?? draft.text },
            focusedId: rescue.id,
          }
        }
      }
      return change({ ...state, status: 'ready', ...reopened }, doc, next(), {
        baseHash: action.hash,
        savedText: action.text,
        notice,
      })
    }
    case 'notice':
      return { ...state, notice: action.notice }
  }
}
