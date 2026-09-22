import { splitText } from './split.ts'
import type { Block, Doc, MintId, Slice } from './types.ts'

/** Longest common subsequence over (kind, raw); returns matched index pairs in order. */
function lcsPairs(oldBlocks: Block[], newSlices: Slice[]): [number, number][] {
  const n = oldBlocks.length
  const m = newSlices.length
  const same = (i: number, j: number) =>
    oldBlocks[i]?.raw === newSlices[j]?.raw && oldBlocks[i]?.kind === newSlices[j]?.kind
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as number[]
    const below = table[i + 1] as number[]
    for (let j = m - 1; j >= 0; j--) {
      row[j] = same(i, j)
        ? (below[j + 1] as number) + 1
        : Math.max(below[j] as number, row[j + 1] as number)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const down = (table[i + 1] as number[])[j] as number
    const right = (table[i] as number[])[j + 1] as number
    if (same(i, j)) pairs.push([i++, j++])
    else if (down >= right) i++
    else j++
  }
  return pairs
}

/**
 * The one algorithm behind re-split on blur, the external-file reload, and the post-condition of
 * structural ops: split the new text, keep IDs for blocks whose raw is unchanged, give the first
 * block of each changed run the old ID of that run (so a split keeps the first ID and a merge
 * keeps the earlier one), and mint IDs for the rest.
 */
export function reconcile(oldDoc: Doc, newText: string, mintId: MintId): Doc {
  const { slices, gaps } = splitText(newText)
  const ids = new Array<string | undefined>(slices.length).fill(undefined)
  const pairs = lcsPairs(oldDoc.blocks, slices)
  let oldCursor = 0
  let newCursor = 0
  for (const [oldIndex, newIndex] of [...pairs, [oldDoc.blocks.length, slices.length] as const]) {
    if (newCursor < newIndex && oldCursor < oldIndex) {
      const inherited = oldDoc.blocks[oldCursor]
      if (inherited !== undefined && inherited.kind === slices[newCursor]?.kind) {
        ids[newCursor] = inherited.id
      }
    }
    if (newIndex < slices.length) ids[newIndex] = oldDoc.blocks[oldIndex]?.id
    oldCursor = oldIndex + 1
    newCursor = newIndex + 1
  }
  return { blocks: slices.map((slice, index) => ({ ...slice, id: ids[index] ?? mintId() })), gaps }
}

/**
 * The strict half of `reconcile`, for identity restored across a page reload: an old ID goes
 * back only onto a block whose text (and kind) is unchanged; everything else gets a new ID.
 *
 * `reconcile`'s inheritance — a changed run's first block keeps the run's old ID — is right while
 * the writer watches a live edit or an outside change land. After a reload the tab was away for an
 * unknown time, and that first block can be unrelated text: a job aimed at the old ID would show
 * its proposal on it. A fresh ID instead leaves the job without its target, and it goes stale
 * with its output kept.
 */
export function reattach(oldDoc: Doc, newText: string, mintId: MintId): Doc {
  const { slices, gaps } = splitText(newText)
  const ids = new Array<string | undefined>(slices.length).fill(undefined)
  for (const [oldIndex, newIndex] of lcsPairs(oldDoc.blocks, slices)) {
    ids[newIndex] = oldDoc.blocks[oldIndex]?.id
  }
  return { blocks: slices.map((slice, index) => ({ ...slice, id: ids[index] ?? mintId() })), gaps }
}
