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

  it('extracts title, date and tags from JSON', () => {
    expect(
      summariseFrontMatter(
        '{\n  "title": "C",\n  "date": "2026-09-22T08:00:00Z",\n  "tags": ["json", 7, "hugo"]\n}',
      ),
    ).toEqual({ title: 'C', date: '2026-09-22', tags: ['json', 'hugo'] })
    expect(summariseFrontMatter('{"title": 1, "tags": "one"}')).toEqual({
      title: undefined,
      date: undefined,
      tags: ['one'],
    })
  })

  it('stays quiet on malformed front matter', () => {
    const empty = { title: undefined, date: undefined, tags: [] }
    expect(summariseFrontMatter('---\n{{{\n---')).toEqual(empty)
    expect(summariseFrontMatter('{ "title": ')).toEqual(empty)
    expect(summariseFrontMatter('{"title": null}')).toEqual(empty)
  })
})
