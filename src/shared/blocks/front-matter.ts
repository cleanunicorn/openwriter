import { parseKeyValues } from '../key-values.ts'

export type FrontMatterSummary = { title?: string; date?: string; tags: string[] }

/** JSON front matter's top-level values, reduced to what the key/value reader would give. */
function jsonValues(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The quiet title/date/tags line. Display only: on anything unexpected the fields stay empty. */
export function summariseFrontMatter(raw: string): FrontMatterSummary {
  const values: Record<string, unknown> = raw.trimStart().startsWith('{')
    ? jsonValues(raw)
    : parseKeyValues(raw)
  const stringValue = (key: string) => {
    const value = values[key]
    return typeof value === 'string' ? value : undefined
  }
  const tags = values.tags
  return {
    title: stringValue('title'),
    date: stringValue('date')?.slice(0, 10),
    tags: Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === 'string')
      : typeof tags === 'string'
        ? [tags]
        : [],
  }
}
