import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Every type and spacing value in the client comes from the scales on :root in theme.css
// (DECISIONS.md, "Type and spacing scales"). A raw size in a rule is a second, ad-hoc scale.
const dir = import.meta.dirname
const css = readFileSync(path.join(dir, 'theme.css'), 'utf8')

const TYPE = /^(font|font-size|line-height|font-weight|letter-spacing)$/
const SPACING =
  /^(margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(row-|column-)?gap$|^(top|right|bottom|left|inset)$/
const RAW = /-?\d*\.?\d+(px|rem)\b/

/**
 * Genuine exceptions, each keyed `selector | property: value`. Borders, outlines, radii, shadows,
 * widths and heights are not checked at all (hairlines and fixed boxes are not a scale).
 */
const ALLOWED = new Set([
  // Geometry, not spacing: the 40px drag gutter plus a 4px gap, inside the column's 48px margin
  // (src/client/shell/layout.ts); it follows the gutter's width, not the spacing scale.
  '.gutter | left: -44px',
])

type Declaration = { selector: string; property: string; value: string }

/** The declarations of every rule outside the token blocks, with the selector they sit under. */
function declarations(source: string): Declaration[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Declaration[] = []
  const stack: string[] = []
  let buffer = ''
  for (const char of text) {
    if (char === '{') {
      stack.push(buffer.trim())
      buffer = ''
    } else if (char === '}') {
      collect(buffer)
      stack.pop()
      buffer = ''
    } else if (char === ';') {
      collect(buffer)
      buffer = ''
    } else {
      buffer += char
    }
  }
  function collect(chunk: string) {
    const match = chunk.trim().match(/^([a-z-]+)\s*:\s*([\s\S]+)$/)
    if (match === null) return
    const selector = stack.at(-1) ?? ''
    found.push({ selector, property: match[1] as string, value: (match[2] as string).trim() })
  }
  return found
}

/** A declaration's value with its `var(...)` references removed (a fallback may hold anything). */
const withoutVars = (value: string) => {
  let out = value
  while (/var\([^()]*\)/.test(out)) out = out.replace(/var\([^()]*\)/g, '')
  return out
}

function violations(source: string): string[] {
  const bad: string[] = []
  for (const { selector, property, value } of declarations(source)) {
    if (property.startsWith('--')) continue
    const key = `${selector.replace(/\s+/g, ' ')} | ${property}: ${value}`
    if (ALLOWED.has(key)) continue
    const bare = withoutVars(value)
    if (TYPE.test(property)) {
      // Keywords (inherit, normal) are fine; any number is a size that belongs on the scale.
      if (/\d/.test(bare)) bad.push(key)
      continue
    }
    if (!SPACING.test(property)) continue
    if (RAW.test(bare)) bad.push(key)
    // em spacing follows the text's size: only the article's rhythm (.rendered) may use it.
    else if (/\d\.?\d*em\b/.test(bare) && !selector.includes('.rendered')) bad.push(key)
  }
  return bad
}

describe('theme.css uses the type and spacing scales', () => {
  it('has no raw type or spacing value outside the token definitions', () => {
    expect(violations(css)).toEqual([])
  })

  it('keeps every allow-list entry in use', () => {
    const present = new Set(
      declarations(css).map(
        (d) => `${d.selector.replace(/\s+/g, ' ')} | ${d.property}: ${d.value}`,
      ),
    )
    expect([...ALLOWED].filter((entry) => !present.has(entry))).toEqual([])
  })

  it('refers only to tokens that are defined', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    const used = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])
    expect(used.filter((name) => !defined.has(name))).toEqual([])
  })

  it('catches the shapes it is meant to catch', () => {
    const sample = `
      :root { --space-1: 2px; }
      .a { padding: 4px var(--space-1); }
      .b { font: 13px / 1.5 system-ui; }
      .c { line-height: 1.4; }
      .d { margin-top: 0.5em; }
      .rendered p { margin-top: 0.5em; }
      .e { gap: var(--space-1); border: 1px solid; width: 40px; }
      @media (max-width: 700px) { .f { top: 24px; } }`
    expect(violations(sample)).toEqual([
      '.a | padding: 4px var(--space-1)',
      '.b | font: 13px / 1.5 system-ui',
      '.c | line-height: 1.4',
      '.d | margin-top: 0.5em',
      '.f | top: 24px',
    ])
  })
})

// Inline styles in components: a style={{ … }} literal or a cssText string with a raw size.
const INLINE_ALLOWED = new Set([
  // The export stage is parked off screen to measure the article at its column width; not spacing.
  'render/export-html.ts | left:-10000px',
])

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
}

/** Every `file | property:value` with a raw number in a style={{ … }} literal or a cssText string. */
function inlineSizes(): string[] {
  const found: string[] = []
  const props =
    /(fontSize|lineHeight|fontWeight|letterSpacing|margin[\w-]*|padding[\w-]*|gap|top|right|bottom|left|inset|font-size|line-height|letter-spacing)\s*:\s*['"`]?(-?[\d.]+(px|rem)?)/g
  for (const file of sources(dir)) {
    const text = readFileSync(file, 'utf8')
    // With `/` on every platform, so the allow-list entries match on Windows too.
    const rel = path.relative(dir, file).split(path.sep).join('/')
    const styles = [
      ...[...text.matchAll(/style=\{\{([\s\S]*?)\}\}/g)].map((m) => m[1] as string),
      ...[...text.matchAll(/cssText\s*=\s*(['"`])([\s\S]*?)\1/g)].map((m) => m[2] as string),
    ]
    for (const style of styles) {
      for (const m of style.matchAll(props)) {
        if (!/^-?0$/.test(m[2] as string)) found.push(`${rel} | ${m[1]}:${m[2]}`)
      }
    }
  }
  return found
}

describe('client components use the scales for inline styles too', () => {
  const found = inlineSizes()

  it('has no raw type or spacing value in an inline style', () => {
    expect(found.filter((entry) => !INLINE_ALLOWED.has(entry))).toEqual([])
  })

  it('keeps every inline allow-list entry in use', () => {
    expect([...INLINE_ALLOWED].filter((entry) => !found.includes(entry))).toEqual([])
  })
})
