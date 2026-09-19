import { describe, expect, it } from 'vitest'
import { pairedShortcodeRanges, scanShortcodeTags } from './shortcodes.ts'
import { splitText } from './split.ts'

describe('scanShortcodeTags', () => {
  it('reads both delimiters, openers and closers', () => {
    expect(scanShortcodeTags('{{< a >}} x {{% b "p" %}} y {{% /b %}} {{< /a >}}')).toEqual([
      { name: 'a', kind: 'open' },
      { name: 'b', kind: 'open' },
      { name: 'b', kind: 'close' },
      { name: 'a', kind: 'close' },
    ])
  })

  it('skips self-closing tags, the comment form, and code spans', () => {
    expect(scanShortcodeTags('{{< img src="a" />}} {{</* note */>}} `{{< note >}}`')).toEqual([])
  })

  it('does not treat a delimiter inside a quoted parameter as the end of the tag', () => {
    expect(scanShortcodeTags('{{< note title="a >}} b" >}}')).toEqual([
      { name: 'note', kind: 'open' },
    ])
  })

  it('tolerates an unterminated tag', () => {
    expect(scanShortcodeTags('text {{< note')).toEqual([])
  })
})

describe('pairedShortcodeRanges', () => {
  const blocks = (...raws: string[]) => raws.map((raw) => ({ raw, scan: true }))

  it('pairs a closer with the nearest unmatched opener of the same name', () => {
    expect(pairedShortcodeRanges(blocks('{{< a >}}', 'x', '{{< /a >}}', 'y'))).toEqual([[0, 2]])
  })

  it('merges nested pairs into the outer range', () => {
    expect(
      pairedShortcodeRanges(blocks('{{< a >}}', '{{< b >}}', 'x', '{{< /b >}}', '{{< /a >}}')),
    ).toEqual([[0, 4]])
  })

  it('leaves an opener with no closer standalone: it swallows nothing', () => {
    expect(pairedShortcodeRanges(blocks('{{< a >}}', 'x', 'y'))).toEqual([])
  })

  it('ignores a stray closer and a pair inside one block', () => {
    expect(pairedShortcodeRanges(blocks('{{< /a >}}', '{{< b >}}x{{< /b >}}'))).toEqual([])
  })

  it('skips blocks that must not be scanned (fences)', () => {
    const input = [
      { raw: '{{< a >}}', scan: true },
      { raw: '```\n{{< /a >}}\n```', scan: false },
      { raw: 'end', scan: true },
    ]
    expect(pairedShortcodeRanges(input)).toEqual([])
  })
})

describe('shortcodes in split', () => {
  it('keeps neighbours separate and the pair whole', () => {
    const text = 'Before.\n\n{{< note >}}\nOne.\n\nTwo.\n{{< /note >}}\n\nAfter.\n'
    expect(splitText(text).slices.map((slice) => slice.raw)).toEqual([
      'Before.',
      '{{< note >}}\nOne.\n\nTwo.\n{{< /note >}}',
      'After.',
    ])
  })

  it('does not pair across a fence that only mentions the closer', () => {
    const text = '{{< note >}}\n\n```\n{{< /note >}}\n```\n\nAfter.\n'
    expect(splitText(text).slices).toHaveLength(3)
  })
})
