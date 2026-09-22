import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { merge3 } from './merge.ts'
import { splitText } from './split.ts'

const doc = (...blocks: string[]) => `${blocks.join('\n\n')}\n`

describe('merge3', () => {
  const base = doc('One', 'Two', 'Three')

  it('takes the other side byte for byte when one side did not change', () => {
    const theirs = '---\ntitle: x\n---\n\nOne\n\n\nTwo  \n\n{{< note >}}\nhi\n{{< /note >}}\n'
    expect(merge3(base, base, theirs)).toMatchObject({ text: theirs, conflicts: [] })
    expect(merge3(base, theirs, base)).toMatchObject({ text: theirs, conflicts: [] })
  })

  it('keeps both sides’ changes to different blocks, adjacent ones included', () => {
    const merged = merge3(base, doc('One MINE', 'Two', 'Three'), doc('One', 'Two THEIRS', 'Three'))
    expect(merged.text).toBe(doc('One MINE', 'Two THEIRS', 'Three'))
    expect(merged.conflicts).toEqual([])
  })

  it('keeps an insertion from one side next to an edit from the other', () => {
    const merged = merge3(
      base,
      doc('One', 'New', 'Two', 'Three'),
      doc('One', 'Two THEIRS', 'Three'),
    )
    expect(merged.text).toBe(doc('One', 'New', 'Two THEIRS', 'Three'))
    expect(merged.conflicts).toEqual([])
  })

  it('does not call the same change on both sides a conflict', () => {
    const same = doc('One', 'Two BOTH', 'Three')
    const merged = merge3(base, same, same)
    expect(merged.text).toBe(same)
    expect(merged.conflicts).toEqual([])
    expect(merged.groups.map((group) => group.result)).toEqual(['same'])
  })

  it('reports a block both sides changed differently, and puts the other side’s text in', () => {
    const theirs = doc('One', 'Two THEIRS', 'Three')
    const merged = merge3(base, doc('One', 'Two MINE', 'Three'), theirs)
    expect(merged.text).toBe(theirs)
    expect(merged.conflicts).toHaveLength(1)
    const [conflict] = merged.conflicts
    expect(conflict).toMatchObject({
      result: 'conflict',
      base: 'Two',
      mine: 'Two MINE',
      theirs: 'Two THEIRS',
      mineBlocks: { start: 1, end: 2 },
    })
    // Where the other side's version sits in the merged text.
    expect(merged.text.slice(conflict?.at.start, conflict?.at.end)).toBe('Two THEIRS')
  })

  it('keeps an edit whose block the other side deleted: no text is lost that way', () => {
    const merged = merge3(base, doc('One', 'Two MINE', 'Three'), doc('One', 'Three'))
    expect(merged.text).toBe(doc('One', 'Two MINE', 'Three'))
    expect(merged.conflicts).toEqual([])
    expect(merged.groups[0]).toMatchObject({ result: 'mine', theirsChanged: true })
    // …and from the other side: the edit on disk wins over this side's deletion.
    const reverse = merge3(base, doc('One', 'Three'), doc('One', 'Two THEIRS', 'Three'))
    expect(reverse.text).toBe(doc('One', 'Two THEIRS', 'Three'))
    expect(reverse.conflicts).toEqual([])
  })

  it('takes the side that already holds everything the other one wrote', () => {
    // The disk has this side's new block and one more: nothing of this side's is lost by taking it.
    const merged = merge3(doc('One'), doc('One', 'Mine'), doc('One', 'Mine', 'More'))
    expect(merged.text).toBe(doc('One', 'Mine', 'More'))
    expect(merged.conflicts).toEqual([])
  })

  it('says which blocks of a conflict this side wrote, apart from the ones it kept', () => {
    // The disk rewrote Two and Three into one stretch; this side only edited Three.
    const merged = merge3(
      doc('One', 'Two', 'Three', 'Four'),
      doc('One', 'Two', 'Three MINE', 'Four'),
      doc('One', 'Inserted', 'Two DISK', 'Four'),
    )
    expect(merged.conflicts).toHaveLength(1)
    expect(merged.conflicts[0]).toMatchObject({
      mine: 'Two\n\nThree MINE',
      theirs: 'Inserted\n\nTwo DISK',
      written: 'Three MINE',
    })
  })

  it('reports two different insertions at one place', () => {
    const merged = merge3(doc('One'), doc('One', 'Mine'), doc('One', 'Theirs'))
    expect(merged.text).toBe(doc('One', 'Theirs'))
    expect(merged.conflicts.map((conflict) => [conflict.mine, conflict.theirs])).toEqual([
      ['Mine', 'Theirs'],
    ])
  })

  it('keeps a paired shortcode as one block and front matter untouched', () => {
    const fm = '---\ntitle: T\n---\n'
    const code = '{{< note >}}\ninside\n\nstill inside\n{{< /note >}}'
    const start = `${fm}\n${doc('Intro', code, 'End')}`
    const mine = start.replace('Intro', 'Intro MINE')
    const theirs = start.replace('still inside', 'still inside THEIRS')
    const merged = merge3(start, mine, theirs)
    expect(merged.conflicts).toEqual([])
    expect(merged.text).toBe(mine.replace('still inside', 'still inside THEIRS'))
    expect(merged.text.startsWith(fm)).toBe(true)
  })

  it('keeps the line endings of the text it took', () => {
    const crlf = 'One\r\n\r\nTwo\r\n'
    const merged = merge3(crlf, 'One MINE\r\n\r\nTwo\r\n', 'One\r\n\r\nTwo THEIRS\r\n')
    expect(merged.text).toBe('One MINE\r\n\r\nTwo THEIRS\r\n')
  })

  it('handles empty texts', () => {
    expect(merge3('', '', 'New\n').text).toBe('New\n')
    expect(merge3('', 'New\n', '').text).toBe('New\n')
    expect(merge3('Old\n', '', '')).toMatchObject({ text: '', conflicts: [] })
  })
})

// ── properties ─────────────────────────────────────────────────────────────────────────────

/** Blocks that split on their own; duplicates are allowed, so matching has choices to make. */
const POOL = [
  'Plain paragraph.',
  'Same.',
  'Same.',
  '## Heading',
  '- one\n- two',
  '```js\nconst x = 1\n\nconst y = 2\n```',
  '{{< note >}}\ninside\n{{< /note >}}',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '> quoted',
]

type Edit = { kind: 'replace' | 'delete' | 'insert'; at: number }
const edit = fc.record({
  kind: fc.constantFrom('replace' as const, 'delete' as const, 'insert' as const),
  at: fc.nat(12),
})

/** Apply edits to a block list; every text a side writes is unique to it (`M1`, `T3`, …). */
function apply(
  blocks: string[],
  edits: Edit[],
  tag: string,
): { blocks: string[]; wrote: string[] } {
  const out = [...blocks]
  const wrote: string[] = []
  edits.forEach((change, n) => {
    const text = `${tag}${n} wrote this.`
    const at = out.length === 0 ? 0 : change.at % (out.length + (change.kind === 'insert' ? 1 : 0))
    if (change.kind === 'insert' || out.length === 0) {
      out.splice(at, 0, text)
      wrote.push(text)
    } else if (change.kind === 'replace') {
      out[at] = text
      wrote.push(text)
    } else out.splice(at, 1)
  })
  return { blocks: out, wrote }
}

const join = (blocks: string[]) => (blocks.length === 0 ? '' : doc(...blocks))
const baseBlocks = fc.array(fc.constantFrom(...POOL), { maxLength: 8 })

describe('merge3, properties', () => {
  it('returns the other side when one side is the base, and either when both agree', () => {
    fc.assert(
      fc.property(baseBlocks, fc.array(edit, { maxLength: 5 }), (start, edits) => {
        const base = join(start)
        const changed = join(apply(start, edits, 'X').blocks)
        for (const merged of [
          merge3(base, base, changed),
          merge3(base, changed, base),
          merge3(base, changed, changed),
        ]) {
          expect(merged.text).toBe(changed)
          expect(merged.conflicts).toEqual([])
        }
      }),
      { numRuns: 300, seed: 20260922 },
    )
  })

  it('never drops what either side wrote without reporting it', () => {
    fc.assert(
      fc.property(
        baseBlocks,
        fc.array(edit, { maxLength: 5 }),
        fc.array(edit, { maxLength: 5 }),
        (start, mineEdits, theirEdits) => {
          const mine = apply(start, mineEdits, 'M')
          const theirs = apply(start, theirEdits, 'T')
          const merged = merge3(join(start), join(mine.blocks), join(theirs.blocks))
          // What the disk wrote is always in the result: a conflict shows the disk's version.
          for (const text of theirs.wrote) {
            if (theirs.blocks.includes(text)) expect(merged.text).toContain(text)
          }
          // What this side wrote is in the result, or in a conflict the writer is shown.
          for (const text of mine.wrote) {
            if (!mine.blocks.includes(text)) continue
            const reported = merged.conflicts.some((conflict) => conflict.mine.includes(text))
            expect(merged.text.includes(text) || reported).toBe(true)
          }
          for (const conflict of merged.conflicts) {
            expect(merged.text.slice(conflict.at.start, conflict.at.end)).toBe(conflict.theirs)
            expect(conflict.mine).not.toBe(conflict.theirs)
          }
          // The mine ranges point into this side's own blocks.
          const count = splitText(join(mine.blocks)).slices.length
          for (const group of merged.groups) {
            expect(group.mineBlocks.start).toBeGreaterThanOrEqual(0)
            expect(group.mineBlocks.end).toBeLessThanOrEqual(count)
            expect(group.mineBlocks.start).toBeLessThanOrEqual(group.mineBlocks.end)
          }
        },
      ),
      { numRuns: 500, seed: 20260922 },
    )
  })

  it('merges edits to different blocks exactly, without a conflict', () => {
    const distinct = fc.uniqueArray(fc.constantFrom(...new Set(POOL)), {
      minLength: 2,
      maxLength: 8,
    })
    fc.assert(
      fc.property(
        distinct,
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        (start, who) => {
          // Each block is replaced by one side at most: `who[i]` says which.
          const mine = start.map((block, i) => (who[i] === true && i % 2 === 0 ? `M${i}.` : block))
          const theirs = start.map((block, i) =>
            who[i] === true && i % 2 === 1 ? `T${i}.` : block,
          )
          const both = start.map((block, i) =>
            who[i] === true ? (i % 2 === 0 ? `M${i}.` : `T${i}.`) : block,
          )
          const merged = merge3(join(start), join(mine), join(theirs))
          expect(merged.conflicts).toEqual([])
          expect(merged.text).toBe(join(both))
        },
      ),
      { numRuns: 300, seed: 20260922 },
    )
  })
})
