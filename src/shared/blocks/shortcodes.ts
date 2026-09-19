export type ShortcodeTag = { name: string; kind: 'open' | 'close' }

/** Blank out inline code spans so shortcode-looking text inside them is not read as syntax. */
function maskCodeSpans(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1/g, (match) => ' '.repeat(match.length))
}

/**
 * Find Hugo shortcode tags in a block: `{{< name … >}}`, `{{% name … %}}`, and their closers
 * `{{< /name >}}`. Skipped: self-closing tags (`/>}}`), Hugo's commented-out form (the tag body
 * wrapped in slash-star markers), and delimiter text inside quoted parameters.
 */
export function scanShortcodeTags(raw: string): ShortcodeTag[] {
  const text = maskCodeSpans(raw)
  const tags: ShortcodeTag[] = []
  let index = 0
  while (index < text.length) {
    const start = text.indexOf('{{', index)
    if (start === -1) break
    const opener = text[start + 2]
    if (opener !== '<' && opener !== '%') {
      index = start + 2
      continue
    }
    const closer = opener === '<' ? '>}}' : '%}}'
    let cursor = start + 3
    let end = -1
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '"') {
        cursor++
        while (cursor < text.length && text[cursor] !== '"') cursor += text[cursor] === '\\' ? 2 : 1
        cursor++
        continue
      }
      if (text.startsWith(closer, cursor)) {
        end = cursor
        break
      }
      cursor++
    }
    if (end === -1) break
    const inner = text.slice(start + 3, end).trim()
    index = end + closer.length
    if (inner.startsWith('/*') || inner.endsWith('/')) continue
    const isClose = inner.startsWith('/')
    const name = (isClose ? inner.slice(1) : inner).trim().split(/\s+/)[0] ?? ''
    if (name !== '') tags.push({ name, kind: isClose ? 'close' : 'open' })
  }
  return tags
}

/**
 * Pair closers with the nearest unmatched opener of the same name across blocks and return the
 * block index ranges `[first, last]` that must become one block. An opener with no closer stays
 * standalone and swallows nothing.
 */
export function pairedShortcodeRanges(
  blocks: { raw: string; scan: boolean }[],
): [number, number][] {
  const stack: { name: string; block: number }[] = []
  const ranges: [number, number][] = []
  blocks.forEach((block, blockIndex) => {
    if (!block.scan) return
    for (const tag of scanShortcodeTags(block.raw)) {
      if (tag.kind === 'open') {
        stack.push({ name: tag.name, block: blockIndex })
        continue
      }
      let match = -1
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.name === tag.name) {
          match = i
          break
        }
      }
      if (match === -1) continue
      const open = stack[match]
      stack.length = match
      if (open !== undefined && open.block < blockIndex) ranges.push([open.block, blockIndex])
    }
  })
  // Union overlapping or nested ranges.
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}
