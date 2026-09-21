import { describe, expect, it } from 'vitest'
import { docLabel, reviewLabel } from './doc-label.ts'

const articles = [{ slug: 'hello-openwrite', title: 'Hello, openwrite' }]
const hello = { kind: 'article', slug: 'hello-openwrite' } as const

describe('docLabel', () => {
  it('names an article by its title, never by its internal key', () => {
    expect(docLabel(hello, articles)).toBe('Hello, openwrite')
    expect(docLabel(hello, articles)).not.toContain('article:')
  })

  it('falls back to the slug for an article it does not know', () => {
    expect(docLabel({ kind: 'article', slug: 'gone' }, articles)).toBe('gone')
  })

  it('names strategy and briefs the way the column labels them', () => {
    expect(docLabel({ kind: 'strategy' }, articles)).toBe('strategy.md')
    expect(docLabel({ kind: 'brief', slug: 'hello-openwrite' }, articles)).toBe(
      'brief · hello-openwrite',
    )
  })
})

describe('reviewLabel', () => {
  it('says just "Review" for the document on screen', () => {
    expect(reviewLabel(hello, hello, articles)).toBe('Review')
  })

  it('names the other document', () => {
    expect(reviewLabel(hello, { kind: 'strategy' }, articles)).toBe('Review in Hello, openwrite')
    expect(reviewLabel({ kind: 'strategy' }, hello, articles)).toBe('Review in strategy.md')
  })
})
