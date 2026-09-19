import { parseKeyValues } from '../key-values.ts'

export type FrontMatterSummary = { title?: string; date?: string; tags: string[] }

/** The quiet title/date/tags line. Display only: on anything unexpected the fields stay empty. */
export function summariseFrontMatter(raw: string): FrontMatterSummary {
  const values = parseKeyValues(raw)
  const text = (key: string) =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined
  const tags = values.tags
  return {
    title: text('title'),
    date: text('date')?.slice(0, 10),
    tags: Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [],
  }
}
