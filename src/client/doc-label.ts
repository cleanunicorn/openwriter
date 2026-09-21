import { type Article, type DocRef, docKey } from '../shared/api-types.ts'

/** A document as the writer knows it: an article by its title, `strategy.md`, or `brief · <slug>`. */
export function docLabel(ref: DocRef, articles: Article[]): string {
  if (ref.kind === 'strategy') return 'strategy.md'
  if (ref.kind === 'brief') return `brief · ${ref.slug}`
  return articles.find((article) => article.slug === ref.slug)?.title ?? ref.slug
}

/** The label of `ref` when it is not the document on screen; null when it is. */
export function otherDocLabel(
  ref: DocRef,
  current: DocRef | null,
  articles: Article[],
): string | null {
  return current !== null && docKey(current) === docKey(ref) ? null : docLabel(ref, articles)
}

/** "Review" for the document on screen, "Review in <label>" for another one. */
export function reviewLabel(ref: DocRef, current: DocRef | null, articles: Article[]): string {
  const other = otherDocLabel(ref, current, articles)
  return other === null ? 'Review' : `Review in ${other}`
}
