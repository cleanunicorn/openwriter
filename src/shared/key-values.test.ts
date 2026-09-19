import { describe, expect, it } from 'vitest'
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
