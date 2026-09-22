import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// docs/ui-inventory.md must name every palette command, so no option ships without a home.
const root = path.resolve(import.meta.dirname, '..', '..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

const PROVIDERS = [
  'src/client/palette/commands.ts',
  'src/client/settings/commands.ts',
  'src/client/workspaces/commands.ts',
  'src/client/jobs/commands.ts',
  'src/client/export.ts',
]

/** `id: 'name'` → `name`; `` id: `prefix:${…}` `` → `prefix:<` (a family). */
function commandIds(source: string): string[] {
  const fixed = [...source.matchAll(/\bid: '([a-z-]+)'/g)].map((match) => match[1] ?? '')
  const families = [...source.matchAll(/\bid: `([a-z-]+):\$\{/g)].map((match) => `${match[1]}:<`)
  return [...fixed, ...families]
}

/** The page between one `## ` heading and the next: only these parts count as live homes. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  if (start === -1) throw new Error(`no "## ${heading}" section`)
  const end = markdown.indexOf('\n## ', start + 1)
  return markdown.slice(start, end === -1 ? undefined : end)
}

/** The id in the first cell of each table row: `` `new-article` `` → `new-article`, `` `open:<slug>` `` → `open:<`. */
const rowIds = (markdown: string): string[] =>
  [...markdown.matchAll(/^\| `([a-z-]+(?::<)?)[^`]*` \|/gm)].map((match) => match[1] ?? '')

describe('docs/ui-inventory.md', () => {
  const inventory = read('docs/ui-inventory.md')
  const ids = PROVIDERS.flatMap((file) => commandIds(read(file)))
  const rows = rowIds(section(inventory, 'Commands'))

  it('finds the commands it checks', () => {
    // A guard on the extraction itself: if the providers change shape, this test must notice.
    expect(ids).toContain('new-article')
    expect(ids).toContain('workspace-erase:<')
    expect(ids.length).toBeGreaterThanOrEqual(20)
  })

  it('gives every palette command exactly one home, and no home to a command that is gone', () => {
    // Both ways: a command without a row, and a row for a command that no longer exists.
    expect([...rows].sort()).toEqual([...new Set(ids)].sort())
    // Exactly one row each: one home, not two.
    expect(rows.length).toBe(new Set(rows).size)
  })
})

// Controls outside the palette: every labelled control and every button's text in the surfaces
// this inventory covers must be named on the page too (case-insensitive).
const SURFACES = [
  'src/client/shell/Shell.tsx',
  'src/client/shell/LeftPanel.tsx',
  'src/client/jobs/Composer.tsx',
  'src/client/jobs/Tray.tsx',
  'src/client/jobs/ResearchPanel.tsx',
  'src/client/jobs/PromptPill.tsx',
  'src/client/jobs/GhostDiff.tsx',
  'src/client/settings/Settings.tsx',
  'src/client/App.tsx',
]

/** `aria-label="Name"` literals, and text that sits alone on its own line inside JSX. */
function controlLabels(source: string): string[] {
  const labels = [...source.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1] ?? '')
  const texts = [...source.matchAll(/^\s+([A-Z][A-Za-z .…’]*[A-Za-z.…])$/gm)].map(
    (match) => match[1] ?? '',
  )
  return [...labels, ...texts]
}

describe('docs/ui-inventory.md, controls', () => {
  // The history of what was removed does not count as a home.
  const page = read('docs/ui-inventory.md')
  const inventory = page.slice(0, page.indexOf('\n## Removed or merged')).toLowerCase()
  const labels = SURFACES.flatMap((file) => controlLabels(read(file)))

  it('finds the controls it checks', () => {
    expect(labels).toContain('All commands')
    expect(labels).toContain('Message to the agent')
  })

  for (const label of new Set(labels)) {
    it(`names "${label}"`, () => {
      expect(inventory).toContain(label.toLowerCase())
    })
  }
})
