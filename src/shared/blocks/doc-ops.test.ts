import { describe, expect, it } from 'vitest'
import {
  deleteBlocks,
  insertMarkdown,
  mergeWithPrevious,
  moveBlock,
  replaceBlock,
  serialise,
} from './index.ts'
import { setup } from './test-helpers.ts'

const raws = (doc: { blocks: { raw: string }[] }) => doc.blocks.map((block) => block.raw)

describe('moveBlock', () => {
  it('moves raws and leaves gaps at their positions', () => {
    const { doc, mint } = setup('A\n\n\nB\n\nC')
    const moved = moveBlock(doc, 2, 0, mint)
    expect(serialise(moved)).toBe('C\n\n\nA\n\nB')
    expect(moved.blocks.map((block) => block.id)).toEqual(['b3', 'b1', 'b2'])
  })

  it('moving the last block up does not fuse it with its new neighbour', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    expect(serialise(moveBlock(doc, 2, 1, mint))).toBe('A\n\nC\n\nB\n')
  })

  it('adds a blank line only where a touched gap has none', () => {
    const { doc, mint } = setup('# H\nText under heading\n\nTail\n')
    const moved = moveBlock(doc, 2, 1, mint)
    expect(raws(moved)).toEqual(['# H', 'Tail', 'Text under heading'])
    expect(serialise(moved)).toBe('# H\n\nTail\n\nText under heading\n')
  })

  it('uses CRLF when the document does', () => {
    const { doc, mint } = setup('# H\r\nText\r\n\r\nTail\r\n')
    expect(serialise(moveBlock(doc, 2, 1, mint))).toBe('# H\r\n\r\nTail\r\n\r\nText\r\n')
  })

  it('never moves the front matter or anything above it', () => {
    const { doc, mint } = setup('---\nt: 1\n---\n\nA\n\nB\n')
    expect(moveBlock(doc, 0, 2, mint)).toBe(doc)
    expect(raws(moveBlock(doc, 2, 0, mint))).toEqual(['---\nt: 1\n---', 'B', 'A'])
  })

  it('treats JSON front matter the same way', () => {
    const { doc, mint } = setup('{\n  "t": 1\n}\n\nA\n\nB\n')
    expect(moveBlock(doc, 0, 2, mint)).toBe(doc)
    expect(raws(moveBlock(doc, 2, 0, mint))).toEqual(['{\n  "t": 1\n}', 'B', 'A'])
    expect(mergeWithPrevious(doc, 1, mint)).toBeNull()
  })
})

describe('insertMarkdown', () => {
  it('inserts several blocks and keeps the file’s trailing gap at the end', () => {
    const { doc, mint } = setup('A\n\nB\n')
    const next = insertMarkdown(doc, 2, 'X\n\nY', mint)
    expect(serialise(next)).toBe('A\n\nB\n\nX\n\nY\n')
    expect(raws(next)).toEqual(['A', 'B', 'X', 'Y'])
  })

  it('inserts in the middle with blank-line separators', () => {
    const { doc, mint } = setup('A\n\nB\n')
    expect(serialise(insertMarkdown(doc, 1, 'X', mint))).toBe('A\n\nX\n\nB\n')
  })

  it('creates the first block of an empty document', () => {
    const { doc, mint } = setup('')
    expect(serialise(insertMarkdown(doc, 0, 'Hello', mint))).toBe('Hello\n')
  })

  it('never inserts above the front matter', () => {
    const { doc, mint } = setup('---\nt: 1\n---\n\nA\n')
    expect(raws(insertMarkdown(doc, 0, 'X', mint))).toEqual(['---\nt: 1\n---', 'X', 'A'])
  })
})

describe('deleteBlocks', () => {
  it('keeps the gap before a middle block', () => {
    const { doc, mint } = setup('A\n\n\nB\n\nC\n')
    expect(serialise(deleteBlocks(doc, [1], mint))).toBe('A\n\n\nC\n')
  })

  it('keeps the trailing gap when the last block goes', () => {
    const { doc, mint } = setup('A\n\nB\n')
    expect(serialise(deleteBlocks(doc, [1], mint))).toBe('A\n')
  })

  it('deletes several blocks at once', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n\nD\n')
    expect(serialise(deleteBlocks(doc, [0, 2], mint))).toBe('B\n\nD\n')
  })
})

describe('replaceBlock', () => {
  it('re-splits when the new text holds several blocks; the first keeps the ID', () => {
    const { doc, mint } = setup('A\n\nB\n')
    const next = replaceBlock(doc, 0, 'A1\n\nA2', mint)
    expect(raws(next)).toEqual(['A1', 'A2', 'B'])
    expect(next.blocks[0]?.id).toBe('b1')
  })

  it('deletes the block when the text is empty', () => {
    const { doc, mint } = setup('A\n\nB\n')
    expect(serialise(replaceBlock(doc, 0, '  \n', mint))).toBe('B\n')
  })
})

describe('mergeWithPrevious', () => {
  it('joins two paragraphs, keeps the earlier ID, puts the cursor at the join', () => {
    const { doc, mint } = setup('First\n\nSecond\n')
    const result = mergeWithPrevious(doc, 1, mint)
    expect(result).not.toBeNull()
    expect(serialise(result?.doc ?? doc)).toBe('First\nSecond\n')
    expect(result?.focusId).toBe('b1')
    expect(result?.cursor).toBe('First\n'.length)
  })

  it('leaves blocks that cannot fuse as they are', () => {
    const { doc, mint } = setup('# Heading\n\nText\n')
    const result = mergeWithPrevious(doc, 1, mint)
    expect(raws(result?.doc ?? doc)).toEqual(['# Heading', 'Text'])
    expect(result?.focusId).toBe('b2')
    expect(result?.cursor).toBe(0)
  })

  it('stays on its own block when an earlier one says the same thing', () => {
    // The first block with the same text is not necessarily this one: a repeated line is
    // ordinary, and the cursor jumped to the top of the article.
    const { doc, mint } = setup('Same\n\n# Heading\n\nSame\n')
    const result = mergeWithPrevious(doc, 2, mint)
    expect(raws(result?.doc ?? doc)).toEqual(['Same', '# Heading', 'Same'])
    expect(result?.focusId).toBe('b3')
    expect(result?.cursor).toBe(0)
  })

  it('does nothing at the top or below the front matter', () => {
    const { doc, mint } = setup('---\nt: 1\n---\n\nA\n')
    expect(mergeWithPrevious(doc, 0, mint)).toBeNull()
    expect(mergeWithPrevious(doc, 1, mint)).toBeNull()
  })
})
