import {
  type Doc,
  deleteBlocks,
  insertMarkdown,
  type MintId,
  replaceBlock,
} from '../blocks/index.ts'
import type { Op } from './result-schema.ts'
import { START_ANCHOR } from './validate-ops.ts'

export type IndexedOp = { index: number; op: Op }

export type ApplyResult = {
  doc: Doc
  /** Op index → IDs of the blocks it inserted, so later accepts keep the result's order. */
  inserted: Record<number, string[]>
  /** Ops whose target block no longer exists; the job is stale for them. */
  missing: number[]
}

const indexOf = (doc: Doc, id: string) => doc.blocks.findIndex((block) => block.id === id)

/**
 * Apply accepted ops to the live document. Ops address blocks by ID, so they apply to the
 * current text, never to the snapshot. Several inserts at one anchor keep the result's order no
 * matter in which order the writer accepted them: `priorInserted` says where earlier ones landed.
 */
export function applyOps(
  doc: Doc,
  ops: IndexedOp[],
  allOps: Op[],
  priorInserted: Record<number, string[]>,
  mintId: MintId,
): ApplyResult {
  let current = doc
  const inserted: Record<number, string[]> = {}
  const missing: number[] = []
  const placed = (opIndex: number) => inserted[opIndex] ?? priorInserted[opIndex] ?? []

  for (const { index: opIndex, op } of [...ops].sort((a, b) => a.index - b.index)) {
    const atStart = op.block_id === START_ANCHOR
    const anchorIndex = atStart ? -1 : indexOf(current, op.block_id)
    if (!atStart && anchorIndex === -1) {
      missing.push(opIndex)
      continue
    }
    if (op.op === 'delete') {
      current = deleteBlocks(current, [anchorIndex], mintId)
      continue
    }
    if (op.op === 'replace') {
      current = replaceBlock(current, anchorIndex, op.markdown, mintId)
      continue
    }
    // Same-anchor, same-side inserts read in result order: land after the earlier ones that are
    // already in; for insert_before also stay above later ones that were accepted first.
    const positionsOf = (matches: (otherIndex: number) => boolean) =>
      allOps.flatMap((other, otherIndex) =>
        matches(otherIndex) && other.op === op.op && other.block_id === op.block_id
          ? placed(otherIndex)
              .map((id) => indexOf(current, id))
              .filter((position) => position !== -1)
          : [],
      )
    const earlier = positionsOf((otherIndex) => otherIndex < opIndex)
    const later = positionsOf((otherIndex) => otherIndex > opIndex)
    let at = op.op === 'insert_after' ? anchorIndex + 1 : anchorIndex
    if (earlier.length > 0) at = Math.max(...earlier) + 1
    else if (op.op === 'insert_before' && later.length > 0) at = Math.min(...later)
    const known = new Set(current.blocks.map((block) => block.id))
    current = insertMarkdown(current, at, op.markdown, mintId)
    inserted[opIndex] = current.blocks
      .filter((block) => !known.has(block.id))
      .map((block) => block.id)
  }
  return { doc: current, inserted, missing }
}
