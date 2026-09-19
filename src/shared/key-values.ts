export type KeyValues = Record<string, string | string[]>

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = trimmed.match(/^(["'])(.*)\1$/)
  return quoted ? (quoted[2] ?? '') : trimmed
}

function parseInlineArray(value: string): string[] {
  return value
    .slice(1, -1)
    .split(',')
    .map(unquote)
    .filter((item) => item !== '')
}

/**
 * A tolerant, dependency-free reader for flat `key: value` (YAML) and `key = "value"` (TOML)
 * lines, inline arrays, and YAML dash lists. It is for display and for skill headers only — the
 * raw text is what gets edited and saved, so an exotic value simply is not shown.
 */
export function parseKeyValues(text: string): KeyValues {
  const result: KeyValues = {}
  let listKey: string | undefined
  for (const line of text.split(/\r\n|\r|\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/) ?? (listKey ? line.match(/^-\s+(.*)$/) : null)
    if (item && listKey !== undefined) {
      const list = result[listKey]
      if (Array.isArray(list)) list.push(unquote(item[1] ?? ''))
      continue
    }
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*[:=]\s*(.*)$/)
    if (pair === null) continue
    const key = pair[1] as string
    const value = (pair[2] ?? '').trim()
    listKey = undefined
    if (value === '') {
      result[key] = []
      listKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = parseInlineArray(value)
    } else {
      result[key] = unquote(value)
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length === 0) delete result[key]
  }
  return result
}

/** Split a `---` fenced header from a body; used by skill templates. */
export function splitHeader(text: string): { header: KeyValues; body: string } {
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (match === null) return { header: {}, body: text }
  return { header: parseKeyValues(match[1] ?? ''), body: text.slice(match[0].length) }
}
