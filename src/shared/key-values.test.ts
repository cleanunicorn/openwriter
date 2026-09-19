import { describe, expect, it } from 'vitest'
import { summariseFrontMatter } from './blocks/front-matter.ts'
import { parseKeyValues, splitHeader } from './key-values.ts'

describe('parseKeyValues', () => {
  it('reads YAML pairs, inline arrays, and dash lists', () => {
    expect(
      parseKeyValues('title: "Hello: world"\ntags: [a, "b c"]\nkeys:\n  - x\n  - y\n'),
    ).toEqual({
      title: 'Hello: world',
      tags: ['a', 'b c'],
      keys: ['x', 'y'],
    })
  })

  it('reads TOML pairs', () => {
    expect(parseKeyValues('title = "T"\ntags = ["a", "b"]')).toEqual({
      title: 'T',
      tags: ['a', 'b'],
    })
  })

  it('ignores what it does not understand', () => {
    expect(parseKeyValues('::: nonsense\n  nested:\n    deep: 1')).toEqual({})
  })
})

describe('summariseFrontMatter', () => {
  it('extracts title, date and tags from YAML and TOML', () => {
    expect(
      summariseFrontMatter('---\ntitle: "A"\ndate: 2026-09-19T10:00:00Z\ntags: ["x"]\n---'),
    ).toEqual({
      title: 'A',
      date: '2026-09-19',
      tags: ['x'],
    })
    expect(summariseFrontMatter('+++\ntitle = "B"\n+++')).toEqual({
      title: 'B',
      date: undefined,
      tags: [],
    })
  })

  it('stays quiet on malformed front matter', () => {
    expect(summariseFrontMatter('---\n{{{\n---')).toEqual({
      title: undefined,
      date: undefined,
      tags: [],
    })
  })
})

describe('splitHeader', () => {
  it('separates a fenced header from the body', () => {
    expect(splitHeader('---\nname: diagram\n---\nBody text\n')).toEqual({
      header: { name: 'diagram' },
      body: 'Body text\n',
    })
  })

  it('returns the whole text when there is no header', () => {
    expect(splitHeader('Just text')).toEqual({ header: {}, body: 'Just text' })
  })
})

describe('names', () => {
  it('a slug is lowercase kebab-case and at most 120 characters, on every side', async () => {
    const { isSlug } = await import('./names.ts')
    expect(isSlug('hello-openwrite')).toBe(true)
    for (const bad of ['', 'Upper', '-lead', 'a/b', 'a.b', 'a'.repeat(121)])
      expect(isSlug(bad)).toBe(false)
    expect(isSlug('a'.repeat(120))).toBe(true)
  })
})
