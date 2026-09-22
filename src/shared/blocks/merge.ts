import { splitText } from './split.ts'
import type { BlockKind } from './types.ts'

/**
 * A block with the whitespace in front of it, or (`end`) the whitespace after the last block. The
 * tokens of a text, joined, are that text byte for byte, so a merge built from tokens re-renders
 * nothing (golden rule 5). The gap travels with the block after it because that is where the
 * editor's own operations put it: a deleted block takes the gap after it along, an inserted one
 * brings the separator before it, and an appended one leaves the file's trailing gap alone.
 */
type Token = { gap: string; raw: string; kind: BlockKind | 'end' }

function tokens(text: string): Token[] {
  const { slices, gaps } = splitText(text)
  return [
    ...slices.map((slice, index) => ({ gap: gaps[index] ?? '', raw: slice.raw, kind: slice.kind })),
    { gap: gaps[slices.length] ?? '', raw: '', kind: 'end' as const },
  ]
}

const sameToken = (a: Token | undefined, b: Token | undefined) =>
  a?.raw === b?.raw && a?.gap === b?.gap && a?.kind === b?.kind

/** Longest common subsequence of two token lists, as matched index pairs in order. */
function lcsPairs(a: Token[], b: Token[]): [number, number][] {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as number[]
    const below = table[i + 1] as number[]
    for (let j = m - 1; j >= 0; j--) {
      row[j] = sameToken(a[i], b[j])
        ? (below[j + 1] as number) + 1
        : Math.max(below[j] as number, row[j + 1] as number)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (sameToken(a[i], b[j])) pairs.push([i++, j++])
    else if (((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number))
      i++
    else j++
  }
  return pairs
}

type Side = 'mine' | 'theirs'
/** Base tokens `[bs, be)` became the side's tokens `[xs, xe)`; `bs === be` is an insertion. */
type Hunk = { side: Side; bs: number; be: number; xs: number; xe: number }

function hunks(
  base: Token[],
  other: Token[],
  side: Side,
): { hunks: Hunk[]; kept: Map<number, number> } {
  const out: Hunk[] = []
  const kept = new Map<number, number>()
  let b = 0
  let x = 0
  for (const [bi, xi] of [...lcsPairs(base, other), [base.length, other.length] as const]) {
    if (bi > b || xi > x) out.push({ side, bs: b, be: bi, xs: x, xe: xi })
    if (bi < base.length) kept.set(bi, xi)
    b = bi + 1
    x = xi + 1
  }
  return { hunks: out, kept }
}

/**
 * Whether two changes touch the same stretch of the base. Ranges that only meet at a boundary do
 * not: an edit of one paragraph and an edit of the next merge cleanly, and an insertion between
 * two blocks does not collide with an edit of either. Two insertions at the same place do.
 */
function overlaps(start: number, end: number, hunk: Hunk): boolean {
  const insertion = hunk.bs === hunk.be
  const point = start === end
  if (insertion && point) return hunk.bs === start
  if (insertion) return start < hunk.bs && hunk.bs < end
  if (point) return hunk.bs < start && start < hunk.be
  return hunk.bs < end && start < hunk.be
}

export type MergeOutcome = 'same' | 'mine' | 'theirs' | 'conflict'

/** One stretch that at least one side changed, and how the merge settled it. */
export type MergeGroup = {
  /**
   * `same`: both sides made the same change. `mine` / `theirs`: that side's text was taken —
   * because only it changed, or because it already holds everything the other side wrote.
   * `conflict`: both wrote something the other does not have; the merged text has `theirs`.
   */
  result: MergeOutcome
  mineChanged: boolean
  theirsChanged: boolean
  /** The blocks of `mine` (indices into `splitText(mine).slices`) this stretch covers. */
  mineBlocks: { start: number; end: number }
  /** Where the stretch's blocks are in the merged text, the whitespace around them excluded. */
  at: { start: number; end: number }
  /** Each side's blocks in this stretch, with the whitespace between them. */
  base: string
  mine: string
  theirs: string
  /**
   * Only the blocks this side wrote here, without the ones it kept from the base: what "keep
   * both" adds after the other side's version, which already has the rest.
   */
  written: string
}

export type Merge = {
  /** The merged text: slices of the three inputs, joined; nothing is re-rendered. */
  text: string
  /** Every stretch at least one side changed, in document order. */
  groups: MergeGroup[]
  /** The groups both sides changed differently: `text` has `theirs` there, `mine` is only here. */
  conflicts: MergeGroup[]
}

/** The blocks of a run of tokens as text: the gap in front of the first and the trailing one dropped. */
function blocksText(run: Token[]): string {
  const blocks = run.filter((token) => token.kind !== 'end')
  return blocks.map((token, index) => (index === 0 ? '' : token.gap) + token.raw).join('')
}

const raws = (run: Token[]) => run.filter((token) => token.kind !== 'end').map((token) => token.raw)

/** Does `holder` contain every block of `run` that is not in `base` (counting repeats)? */
function holdsAllNew(run: Token[], base: Token[], holder: Token[]): boolean {
  const count = (list: string[]) => {
    const counts = new Map<string, number>()
    for (const raw of list) counts.set(raw, (counts.get(raw) ?? 0) + 1)
    return counts
  }
  const inBase = count(raws(base))
  const held = count(raws(holder))
  for (const [raw, n] of count(raws(run))) {
    const written = n - (inBase.get(raw) ?? 0)
    if (written > 0 && (held.get(raw) ?? 0) < n) return false
  }
  return true
}

/**
 * Three-way merge at block level: `base` is the text both sides started from, `mine` the local
 * document, `theirs` the file on disk. A stretch only one side changed takes that side's text; a
 * stretch both changed takes the side that already holds everything the other one wrote (so an
 * edit survives the other side deleting its block, and nothing written is dropped), and failing
 * that it is a conflict: the merged text has the disk's version and the conflict carries this
 * side's, so neither is ever discarded without a word.
 *
 * Blocks are compared with the whitespace in front of them (see `Token`), so the merge of an
 * untouched side is the other side exactly.
 */
export function merge3(base: string, mine: string, theirs: string): Merge {
  const b = tokens(base)
  const sides = { mine: tokens(mine), theirs: tokens(theirs) }
  const ofMine = hunks(b, sides.mine, 'mine')
  const ofTheirs = hunks(b, sides.theirs, 'theirs')
  const kept = { mine: ofMine.kept, theirs: ofTheirs.kept }
  const all = [...ofMine.hunks, ...ofTheirs.hunks].sort((x, y) => x.bs - y.bs || x.be - y.be)

  // Changes that touch the same stretch of the base form one group.
  const grouped: { start: number; end: number; hunks: Hunk[] }[] = []
  for (const hunk of all) {
    const last = grouped[grouped.length - 1]
    if (last !== undefined && overlaps(last.start, last.end, hunk)) {
      last.start = Math.min(last.start, hunk.bs)
      last.end = Math.max(last.end, hunk.be)
      last.hunks.push(hunk)
    } else grouped.push({ start: hunk.bs, end: hunk.be, hunks: [hunk] })
  }

  /** A side's tokens for base `[start, end)`: its own changes there, the base where it kept it. */
  const content = (side: Side, start: number, end: number, own: Hunk[]) => {
    const run: Token[] = []
    const indices: number[] = []
    const take = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        run.push(sides[side][i] as Token)
        indices.push(i)
      }
    }
    let p = start
    for (const hunk of own) {
      for (; p < hunk.bs; p++) take(kept[side].get(p) as number, (kept[side].get(p) as number) + 1)
      take(hunk.xs, hunk.xe)
      p = hunk.be
    }
    for (; p < end; p++) take(kept[side].get(p) as number, (kept[side].get(p) as number) + 1)
    return { run, indices }
  }

  const blockCount = sides.mine.length - 1
  let text = ''
  const groups: MergeGroup[] = []
  let p = 0
  const emit = (run: Token[]) => {
    for (const token of run) text += token.gap + token.raw
  }
  for (const group of grouped) {
    emit(b.slice(p, group.start))
    p = group.end
    const own = (side: Side) => group.hunks.filter((hunk) => hunk.side === side)
    const mineSide = content('mine', group.start, group.end, own('mine'))
    const theirSide = content('theirs', group.start, group.end, own('theirs'))
    const baseRun = b.slice(group.start, group.end)
    const mineChanged = own('mine').length > 0
    const theirsChanged = own('theirs').length > 0
    const joined = (run: Token[]) => run.map((token) => token.gap + token.raw).join('')
    let result: MergeOutcome
    if (!theirsChanged) result = 'mine'
    else if (!mineChanged) result = 'theirs'
    else if (joined(mineSide.run) === joined(theirSide.run)) result = 'same'
    else if (holdsAllNew(mineSide.run, baseRun, theirSide.run)) result = 'theirs'
    else if (holdsAllNew(theirSide.run, baseRun, mineSide.run)) result = 'mine'
    else result = 'conflict'
    const taken = result === 'mine' || result === 'same' ? mineSide.run : theirSide.run
    const before = text.length
    emit(taken)
    const firstBlock = taken.findIndex((token) => token.kind !== 'end')
    const blocks = taken.filter((token) => token.kind !== 'end')
    const start = before + (firstBlock === -1 ? 0 : (taken[firstBlock]?.gap.length ?? 0))
    const mineIndices = mineSide.indices.filter((index) => index < blockCount)
    // Where the stretch is in `mine` when this side has no blocks there (it deleted them all).
    const at = Math.min(own('mine')[0]?.xs ?? kept.mine.get(group.start) ?? blockCount, blockCount)
    groups.push({
      result,
      mineChanged,
      theirsChanged,
      mineBlocks:
        mineIndices.length === 0
          ? { start: at, end: at }
          : {
              start: mineIndices[0] as number,
              end: (mineIndices[mineIndices.length - 1] as number) + 1,
            },
      at: { start, end: start + blocksText(blocks).length },
      base: blocksText(baseRun),
      mine: blocksText(mineSide.run),
      theirs: blocksText(theirSide.run),
      written: blocksText(own('mine').flatMap((hunk) => sides.mine.slice(hunk.xs, hunk.xe))),
    })
  }
  emit(b.slice(p))
  return { text, groups, conflicts: groups.filter((group) => group.result === 'conflict') }
}
