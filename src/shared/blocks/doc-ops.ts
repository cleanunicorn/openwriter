import { reconcile } from './reconcile.ts'
import { serialise } from './serialise.ts'
import { splitText } from './split.ts'
import type { Block, Doc, MintId } from './types.ts'

/** The document's dominant line ending, used only for whitespace an op has to create. */
export function dominantEol(doc: Doc): '\n' | '\r\n' {
  const text = serialise(doc)
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1 - crlf
  return crlf > lf ? '\r\n' : '\n'
}

const hasBlankLine = (gap: string) => (gap.match(/\r\n|\r|\n/g)?.length ?? 0) >= 2

/** A gap an op touched gets a blank-line separator only if it has none; others stay untouched. */
function ensureSeparator(gaps: string[], index: number, separator: string): void {
  if (index <= 0 || index >= gaps.length - 1) return
  if (!hasBlankLine(gaps[index] ?? '')) gaps[index] = separator
}

/**
 * Post-condition of every structural op: splitting the serialised result must give the same
 * raws. When it does not (two blocks fused, one block split), the re-split wins.
 */
function settle(candidate: Doc, mintId: MintId): Doc {
  const text = serialise(candidate)
  const { slices } = splitText(text)
  const same =
    slices.length === candidate.blocks.length &&
    slices.every((slice, index) => slice.raw === candidate.blocks[index]?.raw)
  return same ? candidate : reconcile(candidate, text, mintId)
}

const firstMovable = (doc: Doc) => (doc.blocks[0]?.kind === 'frontmatter' ? 1 : 0)

export function moveBlock(doc: Doc, from: number, to: number, mintId: MintId): Doc {
  const floor = firstMovable(doc)
  const target = Math.max(floor, Math.min(to, doc.blocks.length - 1))
  if (from < floor || from >= doc.blocks.length || from === target) return doc
  const blocks = [...doc.blocks]
  const [moved] = blocks.splice(from, 1)
  blocks.splice(target, 0, moved as Block)
  const gaps = [...doc.gaps]
  const separator = dominantEol(doc).repeat(2)
  for (let i = Math.min(from, target); i <= Math.max(from, target) + 1; i++) {
    ensureSeparator(gaps, i, separator)
  }
  return settle({ blocks, gaps }, mintId)
}

/** Insert markdown (one or several blocks) so that its first block lands at `index`. */
export function insertMarkdown(doc: Doc, index: number, markdown: string, mintId: MintId): Doc {
  const inserted = splitText(markdown)
  if (inserted.slices.length === 0) return doc
  const at = Math.max(firstMovable(doc), Math.min(index, doc.blocks.length))
  const eol = dominantEol(doc)
  const separator = eol.repeat(2)
  const newBlocks = inserted.slices.map((slice) => ({
    ...slice,
    kind: 'content' as const,
    id: mintId(),
  }))
  const innerGaps = inserted.gaps.slice(1, -1).map((gap) => (hasBlankLine(gap) ? gap : separator))
  const blocks = [...doc.blocks]
  blocks.splice(at, 0, ...newBlocks)
  const gaps = [...doc.gaps]
  if (doc.blocks.length === 0) {
    gaps.splice(1, 0, ...innerGaps, eol)
  } else if (at === doc.blocks.length) {
    gaps.splice(at, 0, separator, ...innerGaps)
  } else {
    gaps.splice(at + 1, 0, ...innerGaps, separator)
    ensureSeparator(gaps, at, separator)
  }
  return settle({ blocks, gaps }, mintId)
}

export function deleteBlocks(doc: Doc, indices: number[], mintId: MintId): Doc {
  const blocks = [...doc.blocks]
  const gaps = [...doc.gaps]
  for (const index of [...new Set(indices)].sort((a, b) => b - a)) {
    if (index < 0 || index >= blocks.length) continue
    const isLast = index === blocks.length - 1
    blocks.splice(index, 1)
    // Keep the gap before the block; for the last block keep the file's trailing gap instead.
    gaps.splice(isLast && index > 0 ? index : index + 1, 1)
  }
  return settle({ blocks, gaps }, mintId)
}

/** Replace a block's text. Several blocks' worth of markdown re-splits; empty text deletes. */
export function replaceBlock(doc: Doc, index: number, markdown: string, mintId: MintId): Doc {
  const current = doc.blocks[index]
  if (current === undefined) return doc
  if (markdown.trim() === '') return deleteBlocks(doc, [index], mintId)
  const blocks = doc.blocks.map((block, i) => (i === index ? { ...block, raw: markdown } : block))
  return reconcile(
    { blocks: doc.blocks, gaps: doc.gaps },
    serialise({ blocks, gaps: doc.gaps }),
    mintId,
  )
}

export type MergeResult = { doc: Doc; focusId: string; cursor: number } | null

/**
 * Backspace at the start of a block: join it to the previous block with one line break and let
 * the re-split decide the structure. The earlier block keeps its ID; the cursor sits at the join.
 */
export function mergeWithPrevious(doc: Doc, index: number, mintId: MintId): MergeResult {
  const previous = doc.blocks[index - 1]
  const current = doc.blocks[index]
  if (previous === undefined || current === undefined || previous.kind === 'frontmatter')
    return null
  const eol = dominantEol(doc)
  const gaps = doc.gaps.map((gap, i) => (i === index ? eol : gap))
  const merged = reconcile(doc, serialise({ blocks: doc.blocks, gaps }), mintId)
  const joined = merged.blocks.find((block) => block.id === previous.id)
  if (joined?.raw.startsWith(previous.raw + eol)) {
    return { doc: merged, focusId: joined.id, cursor: previous.raw.length + eol.length }
  }
  // The two blocks cannot fuse (a heading stays a heading): stay where we were.
  const still = merged.blocks.find((block) => block.raw === current.raw) ?? merged.blocks[index]
  return still === undefined ? null : { doc: merged, focusId: still.id, cursor: 0 }
}
