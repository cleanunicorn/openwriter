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
  const opening = lines.exec(text)
  if (opening === null || (opening[1] ?? '').trimEnd() !== fence) return -1
  if (opening[2] === '' || opening[0] === '') return -1
  for (;;) {
    const match = lines.exec(text)
    if (match === null) return -1
    const line = match[1] ?? ''
    if (line.trimEnd() === fence) return match.index + line.length
    if (match[2] === '' || match[0] === '') return -1
  }
}

function trimEnd(text: string, start: number, end: number): number {
  let cursor = end
  while (cursor > start && ' \t\r\n'.includes(text[cursor - 1] ?? '')) cursor--
  return cursor
}

/** Top-level markdown-it token ranges from `contentStart` on; tokens that overlap become one. */
function tokenRanges(text: string, contentStart: number): Range[] {
  const rest = text.slice(contentStart)
  const starts = lineStarts(rest)
  const offsetOfLine = (line: number) => contentStart + (starts[line] ?? rest.length)
  const ranges: Range[] = []
  for (const token of md.parse(rest, {})) {
    if (token.level !== 0 || token.map === null || token.nesting === -1) continue
    const start = offsetOfLine(token.map[0])
    const end = trimEnd(text, start, offsetOfLine(token.map[1]))
    if (end <= start) continue
    const previous = ranges[ranges.length - 1]
    const scan = token.type !== 'fence' && token.type !== 'code_block'
    if (previous !== undefined && start < previous.end) {
      previous.end = Math.max(previous.end, end)
      previous.scan = previous.scan || scan
    } else {
      ranges.push({ start, end, kind: 'content', scan })
    }
  }
  return ranges
}

/**
 * markdown-it emits no token for some source (link reference definitions). Whatever is left
 * between two ranges and is not whitespace becomes its own block, so a gap is whitespace only.
 */
function fillLeftovers(text: string, ranges: Range[], contentStart: number): Range[] {
  const filled: Range[] = []
  const addLeftover = (from: number, to: number) => {
    const between = text.slice(from, to)
    if (isBlank(between)) return
    const firstInk = from + between.search(/[^ \t\r\n]/)
    let start = firstInk
    while (start > from && text[start - 1] !== '\n' && text[start - 1] !== '\r') start--
    filled.push({ start, end: trimEnd(text, start, to), kind: 'content', scan: true })
  }
  let cursor = contentStart
  for (const range of ranges) {
    addLeftover(cursor, range.start)
    filled.push(range)
    cursor = range.end
  }
  addLeftover(cursor, text.length)
  return filled
}

/** A paired shortcode that spans several blocks stays one block. */
function mergePairedShortcodes(text: string, ranges: Range[]): Range[] {
  const pairs = pairedShortcodeRanges(
    ranges.map((range) => ({ raw: text.slice(range.start, range.end), scan: range.scan })),
  )
  const merged: Range[] = []
  let next = 0
  for (const [first, last] of pairs) {
    while (next < first) merged.push(ranges[next++] as Range)
    const head = ranges[first] as Range
    const tail = ranges[last] as Range
    merged.push({ start: head.start, end: tail.end, kind: 'content', scan: true })
    next = last + 1
  }
  while (next < ranges.length) merged.push(ranges[next++] as Range)
  return merged
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

  const content = fillLeftovers(text, tokenRanges(text, contentStart), contentStart)
  ranges.push(...mergePairedShortcodes(text, content))

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
