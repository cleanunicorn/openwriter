import type { Doc } from './types.ts'

/** Pure concatenation. Never serialise from tokens or re-render markdown — that normalises it. */
export function serialise(doc: Pick<Doc, 'gaps'> & { blocks: { raw: string }[] }): string {
  let text = doc.gaps[0] ?? ''
  doc.blocks.forEach((block, index) => {
    text += block.raw + (doc.gaps[index + 1] ?? '')
  })
  return text
}
