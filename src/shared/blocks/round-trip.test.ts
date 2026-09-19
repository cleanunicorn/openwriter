import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createDoc, createIdMinter, serialise, splitText } from './index.ts'

const corpusDir = path.join(import.meta.dirname, 'corpus')
const corpus = (name: string) => readFileSync(path.join(corpusDir, name), 'utf8')

// A deliberate copy of split.ts's `isBlank`: the oracle for "a gap is whitespace only" must not be
// the splitter's own definition, or a change to that definition would pass unnoticed.
const isWhitespace = (gap: string) => /^[ \t\r\n]*$/.test(gap)

function expectLossless(text: string): ReturnType<typeof splitText> {
  const result = splitText(text)
  expect(serialise({ blocks: result.slices, gaps: result.gaps })).toBe(text)
  expect(result.gaps).toHaveLength(result.slices.length + 1)
  result.gaps.forEach((gap, index) => {
    expect(isWhitespace(index === 0 ? gap.replace(/^﻿/, '') : gap)).toBe(true)
  })
  for (const slice of result.slices) {
    expect(slice.raw).not.toBe('')
    expect(slice.raw).toBe(slice.raw.trimEnd())
  }
  return result
}

// String equality alone would pass a splitter that never splits, so every corpus file also
// pins the block count and how each block starts.
const expectations: Record<string, string[]> = {
  'front-matter-yaml.md': ['---\ntitle', '# Heading', 'A paragraph', '---', 'After the', '[ref]:'],
  'front-matter-toml.md': ['+++\ntitle', 'First paragraph', 'Second paragraph'],
  'shortcodes.md': [
    'Intro paragraph',
    '{{< notice warning >}}',
    '{{% details',
    '{{< youtube',
    'The text `{{<',
    '```go-html-template',
    'Closing paragraph',
  ],
  'lists-tables-code.md': ['1. First', '| a | b |', '    indented code', '~~~text', '> A quote'],
  'html-and-odd-whitespace.md': [
    '<div class="note">',
    '<!-- a comment',
    'Paragraph with trailing',
    'Paragraph after three',
    '* * *',
    'Setext heading',
    'Text directly under',
    '<details>',
  ],
  'no-trailing-newline.md': ['no trailing newline'],
}

describe('corpus round trip', () => {
  it('has an expectation for every corpus file', () => {
    expect(readdirSync(corpusDir).sort()).toEqual(Object.keys(expectations).sort())
  })

  for (const [name, starts] of Object.entries(expectations)) {
    it(`${name}: lossless, ${starts.length} blocks at the expected boundaries`, () => {
      const { slices } = expectLossless(corpus(name))
      expect(slices.map((slice) => slice.raw.slice(0, 40))).toEqual(
        starts.map((start) => expect.stringContaining(start)),
      )
      expect(slices).toHaveLength(starts.length)
    })
  }

  it('marks only a leading fenced region as front matter', () => {
    expect(splitText(corpus('front-matter-yaml.md')).slices.map((s) => s.kind)).toEqual([
      'frontmatter',
      'content',
      'content',
      'content',
      'content',
      'content',
    ])
    const notFrontMatter = splitText('Intro\n\n---\n\ntext\n\n---\n')
    expect(notFrontMatter.slices.every((slice) => slice.kind === 'content')).toBe(true)
    expect(splitText('---\ntitle: unclosed\n\ntext\n').slices[0]?.kind).toBe('content')
  })

  it('keeps the whole paired shortcode as one block', () => {
    const { slices } = splitText(corpus('shortcodes.md'))
    expect(slices[1]?.raw.startsWith('{{< notice warning >}}')).toBe(true)
    expect(slices[1]?.raw.endsWith('{{< /notice >}}')).toBe(true)
    expect(slices[2]?.raw.endsWith('{{% /details %}}')).toBe(true)
  })
})

describe('line endings and encoding edge cases', () => {
  const sample = '---\ntitle: x\n---\n\n# Title\n\nOne paragraph\nover two lines.\n\n- a\n- b\n'

  it.each([
    ['LF', sample],
    ['CRLF', sample.replaceAll('\n', '\r\n')],
    ['lone CR', sample.replaceAll('\n', '\r')],
    ['BOM + LF', `﻿${sample}`],
    ['BOM + CRLF', `﻿${sample.replaceAll('\n', '\r\n')}`],
  ])('%s keeps bytes and boundaries', (_name, text) => {
    const { slices, gaps } = expectLossless(text)
    expect(slices.map((slice) => slice.kind)).toEqual([
      'frontmatter',
      'content',
      'content',
      'content',
    ])
    expect(slices[1]?.raw).toBe('# Title')
    if (text.startsWith('﻿')) expect(gaps[0]).toBe('﻿')
  })

  it.each([
    ['empty', ''],
    ['whitespace only', ' \n\t\n\n'],
    ['BOM only', '﻿'],
  ])('%s has no blocks and one gap', (_name, text) => {
    const { slices, gaps } = expectLossless(text)
    expect(slices).toEqual([])
    expect(gaps).toEqual([text])
  })

  it('never writes IDs into the text', () => {
    const doc = createDoc(sample, createIdMinter())
    expect(doc.blocks.map((block) => block.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
    expect(serialise(doc)).toBe(sample)
  })
})

// Property: a document composed from known single-block fragments and arbitrary whitespace gaps
// splits back into exactly those fragments, in any line-ending style.
const fragments = {
  paragraph: ['A plain paragraph.', 'Two lines\nof text with `code` and *emphasis*.', 'Trailing\\'],
  heading: ['# Heading one', '### Deeper heading ###'],
  fence: ['```ts\nconst a = 1\n\nconst b = 2\n```', '~~~\n{{< notice >}}\n~~~'],
  bullets: ['- a\n- b\n  - nested', '* loose\n\n* list'],
  ordered: ['1. one\n2. two'],
  table: ['| a | b |\n|---|---|\n| 1 | 2 |'],
  html: ['<div>\n<p>html</p>\n</div>', '<!-- comment -->'],
  quote: ['> quoted\n> text'],
  shortcode: [
    '{{< notice >}}\nInside.\n\nStill inside.\n{{< /notice >}}',
    // The blank line before the closer matters: directly under a list item the closer would be a
    // lazy continuation of that item, and a following list would join the same markdown list.
    '{{% tip %}}\n# Heading inside\n\n- list\n\n{{% /tip %}}',
    '{{< figure src="x.png" >}}',
  ],
  reference: ['[one]: https://example.com/1'],
  rule: ['***'],
} as const

type Category = keyof typeof fragments
const fragmentArb = fc
  .constantFrom(...(Object.keys(fragments) as Category[]))
  .chain((category) =>
    fc.constantFrom(...fragments[category]).map((raw) => ({ category, raw: raw as string })),
  )
const gapArb = fc.constantFrom('\n\n', '\n\n\n', '\n \n', '\n\t\n\n')

describe('property: split recovers the fragments a document was built from', () => {
  it('holds for random compositions, gaps, and line endings', () => {
    fc.assert(
      fc.property(
        fc.array(fragmentArb, { minLength: 1, maxLength: 12 }),
        fc.array(gapArb, { minLength: 13, maxLength: 13 }),
        fc.constantFrom('\n', '\r\n', '\r'),
        fc.constantFrom('', '\n', '\n\n'),
        fc.boolean(),
        (parts, gapPool, eol, tail, withFrontMatter) => {
          // Neighbours of the same category can legitimately fuse (two lists, two quotes).
          const chosen = parts.filter(
            (part, index) => index === 0 || parts[index - 1]?.category !== part.category,
          )
          const raws = chosen.map((part) => part.raw)
          if (withFrontMatter) raws.unshift('---\ntitle: "t"\n---')
          let text = ''
          raws.forEach((raw, index) => {
            text += raw + (index < raws.length - 1 ? gapPool[index] : tail)
          })
          text = text.replaceAll('\n', eol)
          const { slices } = expectLossless(text)
          expect(slices.map((slice) => slice.raw)).toEqual(
            raws.map((raw) => raw.replaceAll('\n', eol)),
          )
        },
      ),
      { seed: 20260919, numRuns: 400 },
    )
  })
})
