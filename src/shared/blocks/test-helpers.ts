import { createDoc } from './split.ts'
import { createIdMinter } from './types.ts'

/** A document split from `text`, plus the minter that gave it its IDs (`b1`, `b2`, …). */
export function setup(text = 'A\n\nB\n\nC\n') {
  const mint = createIdMinter()
  return { doc: createDoc(text, mint), mint }
}
