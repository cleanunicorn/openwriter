/** Caret at a viewport point, across the two browser APIs. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  const position = doc.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

function lineStartOffsets(raw: string): number[] {
  const starts = [0]
  for (const match of raw.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length)
  return starts
}

/**
 * Map a click on a rendered block to an offset in its markdown. markdown-it has no source maps
 * for inline content, so: take the nearest element that knows its source lines (`data-line`),
 * then look for the text just before the caret inside those lines. Falls back to the line start.
 */
export function clickToOffset(raw: string, target: Element, x: number, y: number): number {
  const lined = target.closest<HTMLElement>('[data-line]')
  if (lined === null) return raw.length
  const starts = lineStartOffsets(raw)
  const from = starts[Number(lined.dataset.line)] ?? 0
  const to = starts[Number(lined.dataset.lineEnd)] ?? raw.length
  const caret = caretAt(x, y)
  if (caret === null || caret.node.nodeType !== Node.TEXT_NODE) return from
  const before = (caret.node.textContent ?? '').slice(0, caret.offset)
  const region = raw.slice(from, to)
  for (const length of [24, 12, 6, 3]) {
    const needle = before.slice(-length)
    if (needle.length < Math.min(length, 3)) continue
    const found = region.indexOf(needle)
    if (found !== -1) return from + found + needle.length
  }
  return from
}
