import { describe, expect, it } from 'vitest'
import { reconcile, serialise } from './index.ts'
import { setup } from './test-helpers.ts'

const ids = (doc: { blocks: { id: string }[] }) => doc.blocks.map((block) => block.id)

describe('reconcile', () => {
  it('keeps every ID when nothing changed', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    expect(ids(reconcile(doc, 'A\n\nB\n\nC\n', mint))).toEqual(['b1', 'b2', 'b3'])
  })

  it('keeps the ID of an edited block and of its untouched neighbours', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    expect(ids(reconcile(doc, 'A\n\nB edited\n\nC\n', mint))).toEqual(['b1', 'b2', 'b3'])
  })

  it('gives the first block of a split the old ID and mints the rest', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    const next = reconcile(doc, 'A\n\nB one\n\nB two\n\nB three\n\nC\n', mint)
    expect(ids(next)).toEqual(['b1', 'b2', 'b4', 'b5', 'b3'])
  })

  it('keeps the earlier ID on a merge', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    expect(ids(reconcile(doc, 'A\nB\n\nC\n', mint))).toEqual(['b1', 'b3'])
  })

  it('follows a block that moved', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    const next = reconcile(doc, 'C\n\nA\n\nB\n', mint)
    expect(next.blocks.find((block) => block.raw === 'A')?.id).toBe('b1')
    expect(next.blocks.find((block) => block.raw === 'B')?.id).toBe('b2')
  })

  it('drops IDs of deleted blocks and never reuses them', () => {
    const { doc, mint } = setup('A\n\nB\n\nC\n')
    const next = reconcile(doc, 'A\n\nC\n\nD\n', mint)
    expect(ids(next)).toEqual(['b1', 'b3', 'b4'])
  })

  it('takes the new text byte for byte', () => {
    const { doc, mint } = setup('A\n\nB\n')
    const text = 'A\r\n\r\n\r\nB changed  \r\n'
    expect(serialise(reconcile(doc, text, mint))).toBe(text)
  })

  it('does not hand a front matter ID to a content block', () => {
    const { doc, mint } = setup('---\ntitle: x\n---\n\nA\n')
    const next = reconcile(doc, 'Intro\n\nA\n', mint)
    expect(next.blocks[0]?.id).not.toBe('b1')
    expect(next.blocks[1]?.id).toBe('b2')
  })
})
