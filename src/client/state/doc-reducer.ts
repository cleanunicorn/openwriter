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
  | { type: 'saved'; text: string; hash: string }
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

/** Apply a structural change as one undoable step. */
function change(
  state: DocState,
  doc: Doc,
  nextId: number,
  extra: Partial<DocState> = {},
): DocState {
  if (doc === state.doc) return { ...state, ...extra }
  return {
    ...state,
    ...extra,
    doc,
    nextId,
    past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
    future: [],
  }
}

/** Fold the focused editor's text into the document without touching history. */
function withDraft(state: DocState, id: string, text: string): { doc: Doc; nextId: number } {
  const { mint, next } = minter(state)
  if (id === NEW_BLOCK_ID) {
    if (text.trim() === '' || state.pendingNew === null)
      return { doc: state.doc, nextId: state.nextId }
    const after = state.pendingNew.afterId
    const index = after === null ? 0 : indexOf(state.doc, after) + 1
    return { doc: insertMarkdown(state.doc, index, text, mint), nextId: next() }
  }
  const index = indexOf(state.doc, id)
  const block = state.doc.blocks[index]
  if (block === undefined || block.raw === text) return { doc: state.doc, nextId: state.nextId }
  return { doc: replaceBlock(state.doc, index, text, mint), nextId: next() }
}

/** The document as the writer sees it right now: committed blocks plus the open editor's text. */
export function liveDoc(state: DocState): Doc {
  return state.draft === null ? state.doc : withDraft(state, state.draft.id, state.draft.text).doc
}

export const liveText = (state: DocState): string => serialise(liveDoc(state))
export const isDirty = (state: DocState): boolean =>
  state.status === 'ready' && liveText(state) !== state.savedText

/** How many blocks sit before and after an editor slot; stable across a commit of that slot. */
function position(state: DocState, id: string): { before: number; tail: number } {
  const length = state.doc.blocks.length
  if (id === NEW_BLOCK_ID) {
    const after = state.pendingNew?.afterId ?? null
    const before = after === null ? 0 : indexOf(state.doc, after) + 1
    return { before, tail: length - before }
  }
  const index = indexOf(state.doc, id)
  return { before: index, tail: length - 1 - index }
}

const blurred = { focusedId: null, draft: null, pendingNew: null } satisfies Partial<DocState>

function commit(state: DocState, id: string, text: string): DocState {
  const { doc, nextId } = withDraft(state, id, text)
  return change(state, doc, nextId, blurred)
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
      return change(state, deleteBlocks(state.doc, indices, mint), next(), { selectedIds: [] })
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
      const { mint, next } = minter(state)
      let doc = reconcile(state.doc, action.text, mint)
      let notice: string | null = 'Reloaded: the file changed on disk.'
      const draft = state.draft
      // Disk wins everywhere except the focused block, which keeps its editor text.
      if (draft !== null && draft.id !== NEW_BLOCK_ID && indexOf(doc, draft.id) === -1) {
        // The focused block vanished on disk: put it back after its nearest surviving neighbour.
        const oldIndex = indexOf(state.doc, draft.id)
        const survivor = state.doc.blocks
          .slice(0, oldIndex)
          .reverse()
          .find((block: Block) => indexOf(doc, block.id) !== -1)
        const at = survivor === undefined ? 0 : indexOf(doc, survivor.id) + 1
        const known = new Set(doc.blocks.map((block) => block.id))
        const inserted = insertMarkdown(doc, at, draft.text.trim() === '' ? '…' : draft.text, mint)
        const fresh = inserted.blocks.find((block) => !known.has(block.id))
        doc = {
          ...inserted,
          blocks: inserted.blocks.map((block) =>
            block === fresh ? { ...block, id: draft.id } : block,
          ),
        }
        notice = 'The file changed on disk. The block you are editing was kept.'
      }
      return change({ ...state, status: 'ready' }, doc, next(), {
        baseHash: action.hash,
        savedText: action.text,
        notice,
      })
    }
    case 'notice':
      return { ...state, notice: action.notice }
  }
}
