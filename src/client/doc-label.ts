import { type Article, type DocRef, docKey } from '../shared/api-types.ts'

/** A document as the writer knows it: an article by its title, `strategy.md`, or `brief · <slug>`. */
export function docLabel(ref: DocRef, articles: Article[]): string {
  if (ref.kind === 'strategy') return 'strategy.md'
  if (ref.kind === 'brief') return `brief · ${ref.slug}`
  return articles.find((article) => article.slug === ref.slug)?.title ?? ref.slug
}

/** "Review" for the document on screen, "Review in <label>" for another one. */
export function reviewLabel(ref: DocRef, current: DocRef | null, articles: Article[]): string {
  return current !== null && docKey(current) === docKey(ref)
    ? 'Review'
    : `Review in ${docLabel(ref, articles)}`
}
