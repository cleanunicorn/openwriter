import { describe, expect, it } from 'vitest'
import { isSlug } from './names.ts'

describe('names', () => {
  it('a slug is lowercase kebab-case and at most 120 characters, on every side', () => {
    expect(isSlug('hello-openwrite')).toBe(true)
    for (const bad of ['', 'Upper', '-lead', 'a/b', 'a.b', 'a'.repeat(121)])
      expect(isSlug(bad)).toBe(false)
    expect(isSlug('a'.repeat(120))).toBe(true)
  })
})
