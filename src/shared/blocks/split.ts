import MarkdownIt from 'markdown-it'
import { pairedShortcodeRanges } from './shortcodes.ts'
import type { Doc, MintId, Slice, SplitResult } from './types.ts'

const md = new MarkdownIt({ html: true })
const BOM = '﻿'

type Range = { start: number; end: number; kind: Slice['kind']; scan: boolean }

const isBlank = (text: string) => /^[ \t\r\n]*$/.test(text)

/** Offsets where each line starts, using markdown-it's definition of a line break. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\n') starts.push(i + 1)
    else if (char === '\r') {
      if (text[i + 1] === '\n') i++
      starts.push(i + 1)
    }
  }
  return starts
}

/** End offset of the front matter fence block starting at `offset`, or -1. */
function frontMatterEnd(text: string, offset: number): number {
  const fence = text.startsWith('---', offset) ? '---' : text.startsWith('+++', offset) ? '+++' : ''
  if (fence === '') return -1
  const lines = /([^\r\n]*)(\r\n|\r|\n|$)/g
  lines.lastIndex = offset
  let first = true
  for (;;) {
    const match = lines.exec(text)
    if (match === null) return -1
    const line = match[1] ?? ''
    if (first) {
      if (line.trimEnd() !== fence) return -1
      first = false
    } else if (line.trimEnd() === fence) {
      return match.index + line.length
    }
    if (match[2] === '' || match[0] === '') return -1
  }
}

function trimEnd(text: string, start: number, end: number): number {
  let cursor = end
  while (cursor > start && ' \t\r\n'.includes(text[cursor - 1] ?? '')) cursor--
  return cursor
}

/**
 * Cut `text` into blocks without normalising anything: blocks are slices of the original text at
 * markdown-it's top-level token line maps, gaps are the exact whitespace between them, and
 * `serialise(split(x)) === x` holds by construction because ranges and gaps partition the input.
 */
export function splitText(text: string): SplitResult {
  const bodyStart = text.startsWith(BOM) ? BOM.length : 0
  const ranges: Range[] = []

  let contentStart = bodyStart
  const fmEnd = frontMatterEnd(text, bodyStart)
  if (fmEnd !== -1) {
    ranges.push({ start: bodyStart, end: fmEnd, kind: 'frontmatter', scan: false })
    contentStart = fmEnd
  }

  const rest = text.slice(contentStart)
  const starts = lineStarts(rest)
  const offsetOfLine = (line: number) => contentStart + (starts[line] ?? rest.length)
  const tokenRanges: Range[] = []
  for (const token of md.parse(rest, {})) {
    if (token.level !== 0 || token.map === null || token.nesting === -1) continue
    const start = offsetOfLine(token.map[0])
    const end = trimEnd(text, start, offsetOfLine(token.map[1]))
    if (end <= start) continue
    const previous = tokenRanges[tokenRanges.length - 1]
    const scan = token.type !== 'fence' && token.type !== 'code_block'
    if (previous !== undefined && start < previous.end) {
      previous.end = Math.max(previous.end, end)
      previous.scan = previous.scan || scan
    } else {
      tokenRanges.push({ start, end, kind: 'content', scan })
    }
  }

  // markdown-it emits no token for some source (link reference definitions). Whatever is left
  // between two ranges and is not whitespace becomes its own block, so a gap is whitespace only.
  let cursor = contentStart
  const contentRanges: Range[] = []
  const addLeftover = (from: number, to: number) => {
    const between = text.slice(from, to)
    if (isBlank(between)) return
    const firstInk = from + between.search(/[^ \t\r\n]/)
    let start = firstInk
    while (start > from && text[start - 1] !== '\n' && text[start - 1] !== '\r') start--
    contentRanges.push({ start, end: trimEnd(text, start, to), kind: 'content', scan: true })
  }
  for (const range of tokenRanges) {
    addLeftover(cursor, range.start)
    contentRanges.push(range)
    cursor = range.end
  }
  addLeftover(cursor, text.length)

  // A paired shortcode that spans several blocks stays one block.
  const pairs = pairedShortcodeRanges(
    contentRanges.map((range) => ({ raw: text.slice(range.start, range.end), scan: range.scan })),
  )
  const mergedContent: Range[] = []
  let next = 0
  for (const [first, last] of pairs) {
    while (next < first) mergedContent.push(contentRanges[next++] as Range)
    const head = contentRanges[first] as Range
    const tail = contentRanges[last] as Range
    mergedContent.push({ start: head.start, end: tail.end, kind: 'content', scan: true })
    next = last + 1
  }
  while (next < contentRanges.length) mergedContent.push(contentRanges[next++] as Range)
  ranges.push(...mergedContent)

  const slices: Slice[] = []
  const gaps: string[] = []
  let position = 0
  for (const range of ranges) {
    gaps.push(text.slice(position, range.start))
    slices.push({ raw: text.slice(range.start, range.end), kind: range.kind })
    position = range.end
  }
  gaps.push(text.slice(position))
  return { slices, gaps }
}

export function createDoc(text: string, mintId: MintId): Doc {
  const { slices, gaps } = splitText(text)
  return { blocks: slices.map((slice) => ({ ...slice, id: mintId() })), gaps }
}
