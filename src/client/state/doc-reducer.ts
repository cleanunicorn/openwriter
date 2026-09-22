import type { DocRef } from '../../shared/api-types.ts'
import {
  type Block,
  createDerivedMinter,
  createDoc,
  type Doc,
  deleteBlocks,
  insertMarkdown,
  type MergeGroup,
  type MintId,
  merge3,
  mergeWithPrevious,
  moveBlock,
  reattach,
  reconcile,
  replaceBlock,
  serialise,
} from '../../shared/blocks/index.ts'

/** ID of the editor slot for a block that does not exist yet (Enter on an empty last line). */
export const NEW_BLOCK_ID = 'new'

export type Draft = { id: string; text: string }

/**
 * A passage this tab and the file both changed, differently, found by a reload (the three-way
 * merge in `shared/blocks/merge.ts`). The document shows the file's version, so autosave cannot
 * write over the other side; the writer's version waits here until they choose.
 */
export type Conflict = {
  id: string
  /** The writer's version, which is in neither the document nor the file. */
  mine: string
  /** The file's version, which the document shows. */
  theirs: string
  /** Only the blocks the writer wrote there: what "keep both" adds after the file's version. */
  written: string
  /** The blocks that held `theirs` when the conflict was found. */
  blockIds: string[]
  /** The block before them: where `mine` goes if they are gone by the time the writer chooses. */
  afterId: string | null
}
export type ConflictChoice = 'mine' | 'theirs' | 'both'

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
  /**
   * Bumped whenever the reducer replaces the draft itself — a reload folding the editor's text
   * in, or a rescue moving it. The open editor holds its own copy of the text and never hears
   * about state changes, so this is what tells the view to build it again from the new draft.
   * Without it the two disagree and whichever writes last wins, which loses the difference.
   */
  draftSeed: number
  pendingNew: PendingNew | null
  selectedIds: string[]
  notice: string | null
  /**
   * The text of the save on its way to disk, if any. When a reload brings exactly that text back,
   * it is this tab's own and the base of the merge; the text last saved would make every
   * keystroke typed since into a conflict with itself.
   */
  sentText: string | null
  /** Passages both sides changed; each is settled with a `resolve`. */
  conflicts: Conflict[]
  nextConflict: number
}

export type DocAction =
  | {
      type: 'loaded'
      text: string
      hash: string | null
      exists: boolean
      /** The document from before a page reload (state/session.ts), to merge and put back. */
      restore?: Restore
    }
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
  | { type: 'sending'; text: string }
  | { type: 'saved'; text: string; hash: string; baseHash: string | null }
  | {
      type: 'external'
      text: string
      hash: string | null
      exists: boolean
      /** The change was another tab's save (#29), not another program's. */
      from?: 'tab'
    }
  | { type: 'resolve'; id: string; keep: ConflictChoice }
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
    draftSeed: 0,
    pendingNew: null,
    selectedIds: [],
    notice: null,
    sentText: null,
    conflicts: [],
    nextConflict: 1,
  }
}

/** A minter that continues the document's counter, so reducers stay pure. */
function minter(state: DocState): { mint: MintId; next: () => number } {
  let next = state.nextId
  return { mint: () => `b${next++}`, next: () => next }
}

const indexOf = (doc: Doc, id: string) => doc.blocks.findIndex((block) => block.id === id)

/**
 * Whether `block` is in `next` as itself: under its ID *and* with its text. Only such a block's
 * position can be trusted. `reconcile` hands the first slice of a changed run the old ID of that
 * run, and an op's replacement keeps the replaced block's ID, so an ID alone can answer for a
 * different paragraph — one another program inserted, say, in front of the one that was edited.
 */
function unchanged(next: Doc, block: Block | undefined): block is Block {
  return block !== undefined && next.blocks[indexOf(next, block.id)]?.raw === block.raw
}

/**
 * Where a position of `previous` — just after `previous.blocks[left]`, just before
 * `previous.blocks[right]` — is in `next`, as the index a block inserted there would get. The
 * neighbours decide it when one of them is still there unchanged, the left one first. When both
 * changed, the region around the position was rewritten and nothing says where in it the
 * position went; the nearest block still answering to its ID is the best guess, and it is kept.
 */
function carriedIndex(previous: Doc, next: Doc, left: number, right: number): number {
  const before = previous.blocks[left]
  if (unchanged(next, before)) return indexOf(next, before.id) + 1
  const after = previous.blocks[right]
  if (unchanged(next, after)) return indexOf(next, after.id)
  const survivor = previous.blocks
    .slice(0, Math.max(left + 1, 0))
    .reverse()
    .find((block: Block) => indexOf(next, block.id) !== -1)
  return survivor === undefined ? 0 : indexOf(next, survivor.id) + 1
}

/**
 * The anchor of an open new-block slot, carried over to `next`: the slot keeps its place between
 * the anchor and the block after it (null = top of the document). Without this, a slot whose
 * anchor was deleted or reloaded away would land at index 0 and autosave would write the
 * paragraph the writer typed at the end of the article to the top of the file.
 */
function reanchor(previous: Doc, next: Doc, pending: PendingNew | null): PendingNew | null {
  if (pending === null || pending.afterId === null) return pending
  const oldIndex = indexOf(previous, pending.afterId)
  if (oldIndex === -1) return indexOf(next, pending.afterId) === -1 ? { afterId: null } : pending
  if (unchanged(next, previous.blocks[oldIndex])) return pending
  const at = carriedIndex(previous, next, oldIndex, oldIndex + 1)
  return { afterId: next.blocks[at - 1]?.id ?? null }
}

/**
 * The block that took in text inserted at `at` when the insert fused into a block already there
 * (an unclosed fence above it swallows it): the block holding the text nearest to the insertion
 * point, the one before it first. Not the first match anywhere — an article can already say the
 * same thing elsewhere, and the editor would reopen on that block instead. Failing a match, the
 * block where the insert went; `at` is an index into the document before the insert, so it is
 * clamped.
 */
function fusedHolder(doc: Doc, at: number, text: string): Block | undefined {
  // `splitText` moves a block's trailing whitespace into the gap after it, so the text to look
  // for is the trimmed one.
  const needle = text.trimEnd()
  const distance = (index: number) => (index < at ? at - 1 - index : index - at)
  let holder: { block: Block; distance: number } | undefined
  doc.blocks.forEach((block, index) => {
    if (!block.raw.includes(needle)) return
    // Strictly nearer only: on a tie the earlier block, which is the side a fusing fence is on.
    if (holder === undefined || distance(index) < holder.distance)
      holder = { block, distance: distance(index) }
  })
  return holder?.block ?? doc.blocks[Math.min(at, doc.blocks.length - 1)]
}

// What a reload says; e2e specs assert them.
const RELOADED = 'Reloaded: the file changed on disk.'
const RELOADED_FROM_TAB = 'Reloaded: another tab saved this file.'
/** The disk deleted the block being edited, and the editor's text was kept. */
const BLOCK_KEPT = 'The file changed on disk. The block you are editing was kept.'
/** Changes of this tab's that were not saved yet survived the reload (#30). */
const TEXT_KEPT = 'The file changed on disk. Your unsaved text was kept.'
export const CONFLICT_NOTICE =
  'The file changed on disk in a passage you had changed too. Choose which version to keep.'

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
  const at = carriedIndex(previous, disk, oldIndex - 1, oldIndex + 1)
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
  const holder = fusedHolder(inserted, at, text)
  // `holder` is always defined here: `fresh === undefined` means `disk` had blocks of its own.
  return { doc: inserted, id: holder?.id ?? draft.id }
}

/**
 * Put a vanished draft's text back and say where its editor should go: under its own ID
 * normally, or another block's when the insert fused into one that was already there. The
 * caller keeps its own notice — the two sites word it differently.
 */
function rescueDraft(
  previous: Doc,
  disk: Doc,
  draft: Draft,
  mint: MintId,
): { doc: Doc; reopened: Partial<DocState> } {
  const rescue = keepFocusedBlock(previous, disk, draft, mint)
  if (rescue.id === draft.id) return { doc: rescue.doc, reopened: {} }
  const holder = rescue.doc.blocks[indexOf(rescue.doc, rescue.id)]
  return {
    doc: rescue.doc,
    reopened: { draft: { id: rescue.id, text: holder?.raw ?? draft.text }, focusedId: rescue.id },
  }
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
    const rescue = rescueDraft(state.doc, doc, draft, mint)
    doc = rescue.doc
    nextId = next()
    rescued = {
      notice: 'A change replaced the block you are editing. Your text was kept.',
      ...rescue.reopened,
      ...(rescue.reopened.draft === undefined ? {} : { draftSeed: state.draftSeed + 1 }),
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

/** The document as the writer sees it right now: committed blocks plus the open editor's text. */
export function liveDoc(state: DocState): Doc {
  // Derived IDs: nothing reserves what this mints, so a stored-looking ID here could be shown
  // to an agent and later given by the store to different text.
  if (state.draft === null) return state.doc
  return withDraft(state, state.draft.id, state.draft.text, createDerivedMinter()).doc
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

/**
 * The open editor's text folded into the document under stored IDs, which is what a reload merges
 * as this tab's side: the same text as `liveText`. `owned` are the blocks that hold the editor's
 * text afterwards; `held` is the one the editor stays on, and what it holds — the first block of
 * a draft that spans several (the rest become blocks of their own), the whole fence of one that
 * swallowed what follows it, or the new block an open slot became. Null when nothing was typed.
 */
function foldIn(state: DocState, mint: MintId): { doc: Doc; owned: string[]; held: Draft | null } {
  const draft = state.draft
  if (draft === null) return { doc: state.doc, owned: [], held: null }
  const doc = withDraft(state, draft.id, draft.text, mint).doc
  if (doc === state.doc) {
    return draft.id === NEW_BLOCK_ID
      ? { doc, owned: [], held: null }
      : { doc, owned: [draft.id], held: draft }
  }
  const known = new Set(state.doc.blocks.map((block) => block.id))
  const fresh = doc.blocks.filter((block) => !known.has(block.id)).map((block) => block.id)
  const at =
    draft.id === NEW_BLOCK_ID
      ? slotIndex(state.doc, state.pendingNew)
      : indexOf(state.doc, draft.id)
  const heldId =
    draft.id !== NEW_BLOCK_ID && indexOf(doc, draft.id) !== -1
      ? draft.id
      : (fresh[0] ?? fusedHolder(doc, at, draft.text)?.id)
  const holder = heldId === undefined ? undefined : doc.blocks[indexOf(doc, heldId)]
  if (holder === undefined) return { doc, owned: fresh, held: null }
  return {
    doc,
    owned: [holder.id, ...fresh.filter((id) => id !== holder.id)],
    held: { id: holder.id, text: holder.raw },
  }
}

/** Where a merged stretch's blocks are in `doc` (whose text is the merged text), by offset. */
function blocksAt(doc: Doc, start: number, end: number): { ids: string[]; afterId: string | null } {
  const ids: string[] = []
  let afterId: string | null = null
  let offset = doc.gaps[0]?.length ?? 0
  doc.blocks.forEach((block, index) => {
    const blockEnd = offset + block.raw.length
    if (offset < end && start < blockEnd) ids.push(block.id)
    else if (blockEnd <= start) afterId = block.id
    offset = blockEnd + (doc.gaps[index + 1]?.length ?? 0)
  })
  return { ids, afterId }
}

/** The base of a reload's merge: the save on its way when that is what the disk holds (#30). */
const mergeBase = (state: DocState, disk: string): string =>
  disk === state.sentText ? disk : state.savedText

/**
 * A reload is a three-way merge (#30): base = the text last loaded or saved (or the save on its
 * way, when that is what came back), mine = the live document with the editor folded in, theirs
 * = the disk. What only one side changed is kept — a finished block autosave had not written yet
 * included — and a passage both changed differently shows the disk's version, with the writer's
 * kept in a `Conflict`. The editor stays open unless the disk changed what it holds; then it
 * closes, so autosave can never write the writer's copy over the other side's (#29's ping-pong).
 * `keepIds` puts the IDs on the merged text: `reconcile` for a reload the writer is watching,
 * `reattach` (unchanged text only) for the first load after a page reload.
 */
function reloaded(
  state: DocState,
  disk: string,
  hash: string | null,
  fromTab: boolean,
  keepIds: typeof reconcile = reconcile,
): DocState {
  const { mint, next } = minter(state)
  const folded = foldIn(state, mint)
  const mineText = serialise(folded.doc)
  const base = mergeBase(state, disk)
  const merge = merge3(base, mineText, disk)
  const doc = keepIds(folded.doc, merge.text, mint)

  const owned = new Set(folded.owned.map((id) => indexOf(folded.doc, id)))
  const ownIndex = state.draft === null ? -1 : indexOf(folded.doc, state.draft.id)
  const blocksOf = ({ mineBlocks }: MergeGroup) =>
    Array.from({ length: mineBlocks.end - mineBlocks.start }, (_, i) => mineBlocks.start + i)
  const touches = (group: MergeGroup) => blocksOf(group).some((index) => owned.has(index))

  let editor: Partial<DocState> = {}
  const held = folded.held
  if (held !== null && state.draft !== null) {
    const overwritten = merge.groups.some(
      (group) => touches(group) && (group.result === 'theirs' || group.result === 'conflict'),
    )
    // The editor stays on its block when the merge left that block as the editor had it. A block
    // that took the editor's text in (an unclosed fence from disk swallowing it) is followed.
    const own = doc.blocks[indexOf(doc, held.id)]
    const fused = fusedHolder(doc, indexOf(folded.doc, held.id), held.text)
    const target =
      own?.raw === held.text
        ? own
        : fused?.raw.includes(held.text.trimEnd()) === true
          ? fused
          : undefined
    if (overwritten || target === undefined) editor = { ...blurred }
    else {
      editor = {
        draft: { id: target.id, text: target.raw },
        focusedId: target.id,
        pendingNew: null,
        // The editor holds its own copy of the text: when that changed, it is built again.
        ...(target.raw === state.draft.text ? {} : { draftSeed: state.draftSeed + 1 }),
        // A slot that became a block, or text that fused into another: the caret goes to the end.
        ...(target.id === state.draft.id ? {} : { focusCursor: 'end' as const }),
      }
    }
  }

  let nextConflict = state.nextConflict
  const found: Conflict[] = merge.conflicts.map((group) => {
    const { ids, afterId } = blocksAt(doc, group.at.start, group.at.end)
    return {
      id: `c${nextConflict++}`,
      mine: group.mine,
      theirs: group.theirs,
      written: group.written,
      blockIds: ids,
      afterId,
    }
  })
  const kept = merge.groups.filter((group) => group.result === 'mine')
  const notice =
    found.length > 0
      ? CONFLICT_NOTICE
      : kept.some((group) => group.theirsChanged && touches(group))
        ? BLOCK_KEPT
        : kept.some(
              (group) => group.theirsChanged || blocksOf(group).some((index) => index !== ownIndex),
            )
          ? TEXT_KEPT
          : fromTab
            ? RELOADED_FROM_TAB
            : RELOADED
  // The undo step is the document as it was on screen, the editor's text folded in: undoing the
  // reload brings back exactly what the writer saw, not the block as it was before they typed.
  return change({ ...state, doc: folded.doc, status: 'ready', ...editor }, doc, next(), {
    baseHash: hash,
    savedText: disk,
    notice,
    conflicts: [...state.conflicts, ...found],
    nextConflict,
  })
}

/** What a page reload kept of a document (state/session.ts), to put back on the first load. */
export type Restore = {
  doc: Doc
  nextId: number
  conflicts?: Conflict[]
  /** The text last loaded or saved; absent, the kept text is the base and the disk wins. */
  base?: string
  /** The save that was on its way as the page went. */
  sent?: string
}

/**
 * The first load after a page reload (#38) runs the merge a reload runs (`reloaded`): mine = the
 * kept document (its editor committed as the page went), theirs = the disk, base = the kept base.
 * So a block finished but not yet saved survives and is then autosaved, a change only the disk
 * made is taken, and a passage both changed is a conflict. The IDs go back only on unchanged text
 * (`reattach`): after an absence of unknown length a changed block can be unrelated text, and a
 * job aimed at it must lose its target and go stale. A conflict the writer had not settled comes
 * back too: its text is nowhere else. There is no undo step: the page before is gone.
 */
function restored(ref: DocRef, restore: Restore, disk: string, hash: string | null): DocState {
  const conflicts = restore.conflicts ?? []
  const text = serialise(restore.doc)
  const kept: DocState = {
    ...initialDocState(ref),
    status: 'ready',
    doc: restore.doc,
    nextId: restore.nextId,
    savedText: restore.base ?? text,
    sentText: restore.sent ?? null,
    conflicts,
    nextConflict: Math.max(0, ...conflicts.map((conflict) => Number(conflict.id.slice(1)))) + 1,
  }
  const base = mergeBase(kept, disk)
  const merged = reloaded(kept, disk, hash, false, reattach)
  // A reload's notice is about a change the writer watched arrive; here only what needs them is
  // said: a conflict, or unsaved text kept against a disk that changed too.
  const notice =
    merged.conflicts.length > 0
      ? CONFLICT_NOTICE
      : text !== base && disk !== base && disk !== text
        ? TEXT_KEPT
        : null
  return { ...merged, past: [], future: [], sentText: null, notice }
}

const paragraphBreak = (text: string) => (text.includes('\r\n') ? '\r\n\r\n' : '\n\n')

/**
 * Settle a conflict. `theirs` keeps the document as it is; `mine` puts the writer's version where
 * the disk's is; `both` puts what the writer wrote after the disk's version (the blocks of the
 * passage the writer left alone are in the disk's already). If the disk's blocks are gone
 * meanwhile, the text goes after the block that was before them. Done on the text and reconciled,
 * like any other change, so front matter and block kinds stay what the splitter says.
 */
function resolve(current: DocState, id: string, keep: ConflictChoice): DocState {
  const conflict = current.conflicts.find((candidate) => candidate.id === id)
  if (conflict === undefined) return current
  // An editor still open on the passage is finished first, so the choice acts on what is there.
  const state = keep === 'theirs' ? current : docReducer(current, { type: 'blur' })
  const conflicts = state.conflicts.filter((candidate) => candidate !== conflict)
  const notice = conflicts.length === 0 && state.notice === CONFLICT_NOTICE ? null : state.notice
  if (keep === 'theirs') return { ...state, conflicts, notice }
  const text = serialise(state.doc)
  const starts: number[] = []
  let offset = state.doc.gaps[0]?.length ?? 0
  state.doc.blocks.forEach((block, index) => {
    starts.push(offset)
    offset += block.raw.length + (state.doc.gaps[index + 1]?.length ?? 0)
  })
  const startOf = (index: number) => starts[index] as number
  const endOf = (index: number) => startOf(index) + (state.doc.blocks[index]?.raw.length ?? 0)
  const present = conflict.blockIds
    .map((blockId) => indexOf(state.doc, blockId))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)
  const first = present[0]
  const last = present[present.length - 1]
  const separator = paragraphBreak(text)
  const added = keep === 'mine' ? conflict.mine : conflict.written
  let next: string
  if (keep === 'mine' && first !== undefined && last !== undefined) {
    next = text.slice(0, startOf(first)) + conflict.mine + text.slice(endOf(last))
  } else {
    const after = last ?? (conflict.afterId === null ? -1 : indexOf(state.doc, conflict.afterId))
    const anchor =
      last === undefined && conflict.afterId !== null && after === -1
        ? state.doc.blocks.length - 1
        : after
    if (anchor === -1) {
      const at = state.doc.gaps[0]?.length ?? 0
      next = text.slice(0, at) + added + separator + text.slice(at)
    } else next = text.slice(0, endOf(anchor)) + separator + added + text.slice(endOf(anchor))
  }
  const { mint, next: nextId } = minter(state)
  return change(state, reconcile(state.doc, next, mint), nextId(), { conflicts, notice })
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case 'loaded': {
      // A brief or strategy that was never written is an empty document, created on first save.
      if (!action.exists && state.ref.kind === 'article')
        return { ...state, status: 'missing', error: null }
      if (action.restore !== undefined)
        return restored(state.ref, action.restore, action.text, action.hash)
      const { mint, next } = minter({ ...state, nextId: 1 })
      return {
        ...initialDocState(state.ref),
        status: 'ready',
        doc: createDoc(action.text, mint),
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
    case 'sending':
      return { ...state, sentText: action.text }
    case 'saved':
      // A save that resolves after a reload moved the document on is one revision behind: its
      // hash would roll `baseHash` back, and the next PUT would be a guaranteed 409.
      if (action.baseHash !== state.baseHash) return state
      return { ...state, baseHash: action.hash, savedText: action.text, sentText: null }
    case 'external':
      if (!action.exists) {
        return {
          ...state,
          status: 'missing',
          notice: 'This file was deleted on disk. Autosave is paused.',
        }
      }
      if (action.hash === state.baseHash) return state
      return reloaded(state, action.text, action.hash, action.from === 'tab')
    case 'resolve':
      return resolve(state, action.id, action.keep)
    case 'notice':
      return { ...state, notice: action.notice }
  }
}
