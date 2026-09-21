import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { docKey, type SkillInfo, SkillInfoSchema } from '../../shared/api-types.ts'
import { DEFAULT_CONFIG } from '../../shared/config-schema.ts'
import { splitHeader } from '../../shared/key-values.ts'
import { docReducer, initialDocState } from '../state/doc-reducer.ts'
import { type Command, filterCommands, GROUP_ORDER, groupCommands } from './group.ts'

// The real providers, registered in App.tsx's order: palette/commands.ts first (jobs/commands.ts
// imports it), then jobs, export, settings, workspaces. They are loaded by a computed URL, not a
// static import: statically, their React types would reach tsconfig.server.json (which checks this
// test without the DOM library) and break its server files' fetch types.
const load = (spec: string): Promise<unknown> => import(new URL(spec, import.meta.url).href)
for (const spec of [
  './commands.ts',
  '../jobs/commands.ts',
  '../export.ts',
  '../settings/commands.ts',
  '../workspaces/commands.ts',
])
  await load(spec)
const { allCommands } = (await load('./commands.ts')) as {
  allCommands: (state: SampleState) => Command[]
}

/**
 * The registry exactly as the providers build it for the sample workspace with its article open,
 * plus three remembered workspaces named like the ones the e2e suite creates. Nothing is copied:
 * a changed title or hint changes what these tests see.
 */
/** The slice of AppState the providers read (AppState itself would pull React's types in too). */
type SampleState = Record<string, unknown>

function sampleState(): SampleState {
  const ref = { kind: 'article', slug: 'hello-openwrite' } as const
  const text = readFileSync(
    path.join(root, 'sample-workspace', 'content', 'posts', 'hello-openwrite', 'index.md'),
    'utf8',
  )
  const doc = docReducer(initialDocState(ref), { type: 'loaded', text, hash: null, exists: true })
  const skills = readdirSync(path.join(root, 'skills'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => skillInfo(readFileSync(path.join(root, 'skills', file), 'utf8')))
  const entry = (id: string, label: string) => ({ id, label, path: `/tmp/${id}` })
  return {
    boot: 'ready',
    current: ref,
    docs: { [docKey(ref)]: doc },
    articles: [{ slug: 'hello-openwrite', title: 'Hello, openwrite' }],
    config: {
      config: DEFAULT_CONFIG,
      error: null,
      contentDirError: null,
      contentOutsideWorkspace: false,
      adapters: ['fake'],
      adapterOverride: null,
    },
    skills,
    workspaces: {
      active: { root: '/tmp/active', label: 'sample' },
      entries: [
        entry('aaaaaaaaaaaa', 'From Hugo'),
        entry('bbbbbbbbbbbb', 'doomed'),
        entry('cccccccccccc', 'The first one'),
      ],
    },
    palette: null,
    panel: null,
    themeEpoch: 0,
  }
}

const root = path.resolve(import.meta.dirname, '..', '..', '..')

/** A skill file's header as /api/skills lists it (the defaults are the server's). */
function skillInfo(text: string): SkillInfo {
  const { header } = splitHeader(text)
  const list = (value: string | string[] | undefined) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  return SkillInfoSchema.parse({
    name: header.name,
    description: header.description,
    scope: header.scope ?? 'blocks',
    stub: header.stub === 'true',
    requires: list(header.requires),
    document: header.document ?? 'current',
  })
}
const REGISTRY = allCommands(sampleState())

describe('groupCommands', () => {
  it('orders sections by GROUP_ORDER and keeps registration order inside each', () => {
    const sections = groupCommands(REGISTRY)
    expect(sections.map((section) => section.group)).toEqual([...GROUP_ORDER])
    expect(sections[0]?.commands.map((c) => c.id)).toEqual([
      'open:hello-openwrite',
      'new-article',
      'edit-strategy',
      'edit-brief',
    ])
    expect(sections.find((s) => s.group === 'app')?.commands.map((c) => c.id)).toEqual([
      'theme',
      'toggle-left',
      'toggle-right',
      'go-left',
      'go-right',
      'settings',
    ])
  })

  it('omits a group with no command', () => {
    const sections = groupCommands(REGISTRY.filter((c) => c.group !== 'export'))
    expect(sections.map((section) => section.group)).not.toContain('export')
    expect(groupCommands([])).toEqual([])
  })

  it('labels every section', () => {
    expect(groupCommands(REGISTRY).map((section) => section.label)).toEqual([
      'Documents',
      'Agent',
      'Export',
      'Workspace',
      'App',
    ])
  })
})

describe('the first match of every palette query the e2e suite runs', () => {
  // `runCommand(page, query)` presses Enter on the first match: grouping must not change it.
  const cases: [string, string][] = [
    ['theme', 'theme'],
    ['new workspace', 'workspace-new'],
    ['delete workspace from disk: doomed', 'workspace-erase:bbbbbbbbbbbb'],
    ['research', 'ask-research'],
    ['whole article', 'ask-article'],
    ['new article', 'new-article'],
    ['draft brief', 'draft-brief'],
    ['edit strategy', 'edit-strategy'],
    ['draft article', 'draft-article'],
    ['edit brief', 'edit-brief'],
    ['export html', 'export-html'],
    ['From Hugo', 'workspace-open:aaaaaaaaaaaa'],
    ['open article hello', 'open:hello-openwrite'],
    ['open hello', 'open:hello-openwrite'],
    ['remove workspace from the list: The first one', 'workspace-forget:cccccccccccc'],
    ['run skill diagram', 'skill:diagram'],
    ['settings', 'settings'],
    ['switch to workspace', 'workspace-open:aaaaaaaaaaaa'],
  ]
  for (const [query, id] of cases) {
    it(`"${query}" → ${id}`, () => {
      // The palette's order: the sections, flattened (Palette.tsx).
      const shown = groupCommands(filterCommands(REGISTRY, query)).flatMap((s) => s.commands)
      expect(shown[0]?.id).toBe(id)
    })
  }

  it('"new art" matches exactly one command', () => {
    expect(filterCommands(REGISTRY, 'new art')).toHaveLength(1)
  })
})
