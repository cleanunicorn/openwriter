import { z } from 'zod'

/** The one list of block kinds: the type, and the schema of a job's snapshot, both come from it. */
export const BlockKindSchema = z.enum(['frontmatter', 'content'])
export type BlockKind = z.infer<typeof BlockKindSchema>

export type Slice = { raw: string; kind: BlockKind }

/** A block is a slice of the original text. Its ID is session-scoped and never written to disk. */
export type Block = Slice & { id: string }

/**
 * `gaps.length === blocks.length + 1`. A gap is the exact whitespace at a position (before the
 * first block, between two blocks, after the last), so it belongs to the position, not to a
 * block: a reorder moves raws and leaves gaps where they are.
 */
export type Doc = { blocks: Block[]; gaps: string[] }

export type SplitResult = { slices: Slice[]; gaps: string[] }

export type MintId = () => string

/** The shape of a block ID wherever one crosses a boundary (a job request, a `result.json`). */
export const BlockIdSchema = z.string().regex(/^b\d+$/)

/** IDs are `b<n>` from a per-document counter. `b0` is reserved for the virtual start anchor. */
export function createIdMinter(start = 1): MintId {
  let next = start
  return () => `b${next++}`
}
