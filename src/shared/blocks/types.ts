export type BlockKind = 'frontmatter' | 'content'

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

/** IDs are `b<n>` from a per-document counter. `b0` is reserved for the virtual start anchor. */
export function createIdMinter(start = 1): MintId {
  let next = start
  return () => `b${next++}`
}
