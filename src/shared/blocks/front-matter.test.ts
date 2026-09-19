import { describe, expect, it } from 'vitest'
import { summariseFrontMatter } from './front-matter.ts'

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
