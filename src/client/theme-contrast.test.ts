import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, WCAG_AA } from '../shared/contrast.ts'

// Contrast is computed from the real tokens in theme.css; normal-size text needs 4.5:1.
const AA = WCAG_AA

const css = readFileSync(path.join(import.meta.dirname, 'theme.css'), 'utf8')

/** The custom properties of every theme block: `:root`, the system-dark media block, `[data-theme=dark]`. */
function themeBlocks(): Record<string, Record<string, string>> {
  const blocks: Record<string, Record<string, string>> = {}
  const names = ['light', 'system dark', 'explicit dark']
  const pattern = /(?::root(?::not\([^)]*\))?(?:\[data-theme=["']dark["']\])?)\s*\{([^}]*)\}/g
  for (const match of css.matchAll(pattern)) {
    const tokens = Object.fromEntries(
      [...(match[1] ?? '').matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [
        m[1],
        m[2],
      ]),
    )
    if (Object.keys(tokens).length > 0)
      blocks[names[Object.keys(blocks).length] ?? `block ${Object.keys(blocks).length}`] =
        tokens as Record<string, string>
  }
  return blocks
}

describe('theme tokens meet WCAG AA for normal text', () => {
  const blocks = themeBlocks()

  it('finds the three theme blocks, and the two dark ones agree', () => {
    expect(Object.keys(blocks)).toEqual(['light', 'system dark', 'explicit dark'])
    expect(blocks['system dark']).toEqual(blocks['explicit dark'])
  })

  // Which text token is drawn on which surface token.
  const pairs: [string, string[]][] = [
    ['--fg', ['--bg', '--code-bg', '--add-bg', '--del-bg']],
    ['--quiet', ['--bg', '--code-bg', '--add-bg', '--del-bg']],
    ['--accent', ['--bg', '--code-bg']],
  ]

  for (const [name, tokens] of Object.entries(blocks)) {
    for (const [text, surfaces] of pairs) {
      for (const surface of surfaces) {
        it(`${name}: ${text} on ${surface}`, () => {
          const ratio = contrast(tokens[text] as string, tokens[surface] as string)
          expect(
            ratio,
            `${tokens[text]} on ${tokens[surface]} = ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(AA)
        })
      }
    }
  }
})
