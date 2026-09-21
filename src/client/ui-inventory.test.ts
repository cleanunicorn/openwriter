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

describe('docs/ui-inventory.md', () => {
  const inventory = read('docs/ui-inventory.md')
  const ids = PROVIDERS.flatMap((file) => commandIds(read(file)))

  it('finds the commands it checks', () => {
    // A guard on the extraction itself: if the providers change shape, this test must notice.
    expect(ids).toContain('new-article')
    expect(ids).toContain('workspace-erase:<')
    expect(ids.length).toBeGreaterThanOrEqual(20)
  })

  for (const id of new Set(ids)) {
    it(`names ${id}`, () => {
      expect(inventory).toContain(`\`${id}`)
    })
  }
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
  const inventory = read('docs/ui-inventory.md').toLowerCase()
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
