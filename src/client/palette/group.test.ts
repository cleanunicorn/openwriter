import { describe, expect, it } from 'vitest'
import {
  type Command,
  type CommandGroup,
  filterCommands,
  GROUP_ORDER,
  groupCommands,
  orderCommands,
} from './group.ts'

const run = () => {}
const command = (id: string, group: CommandGroup, title: string, hint?: string): Command => ({
  id,
  group,
  title,
  ...(hint === undefined ? {} : { hint }),
  run,
})

/**
 * The registry as the sample workspace shows it with the article open, in registration order
 * (palette, jobs, export, settings, workspaces — the import order in App.tsx). Titles and hints are
 * copied from the providers; if one changes, change it here too, or the contract below proves nothing.
 */
const REGISTRY: Command[] = [
  command('open:hello-openwrite', 'documents', 'Open article: Hello, openwrite', 'hello-openwrite'),
  command('new-article', 'documents', 'New article…'),
  command('theme', 'app', 'Theme: switch to light', 'now system'),
  command('toggle-left', 'app', 'Toggle files and actions', 'Ctrl/Cmd+B'),
  command('toggle-right', 'app', 'Toggle agent panel', 'Ctrl/Cmd+Alt+B'),
  command('go-left', 'app', 'Go to files and actions'),
  command('go-right', 'app', 'Go to agent'),
  command('ask-article', 'agent', 'Instruct the agent: whole article…', 'article scope'),
  command('ask-research', 'agent', 'Research question…', 'no edits; answer goes to notes'),
  command(
    'skill:diagram',
    'agent',
    'Run skill: diagram',
    'Produce a mermaid diagram as a fenced code block',
  ),
  command(
    'skill:image',
    'agent',
    'Run skill: image',
    'Generate an image with the agent configured for image tasks',
  ),
  command('export-markdown', 'export', 'Export: markdown + assets (zip)', 'the bundle as is'),
  command('export-html', 'export', 'Export: standalone HTML + assets (zip)', 'diagrams rendered'),
  command('settings', 'app', 'Settings…', 'agents, content directory, theme'),
  command('edit-strategy', 'documents', 'Edit strategy', 'strategy.md'),
  command('edit-brief', 'documents', 'Edit brief', 'brief for hello-openwrite'),
  command('draft-brief', 'agent', 'Draft brief from my notes', 'a job; you review the result'),
  command('draft-article', 'agent', 'Draft article from brief', 'a job; you review the result'),
  command('workspace-open:1', 'workspace', 'Switch to workspace: From Hugo', '/tmp/hugo'),
  command('workspace-open:2', 'workspace', 'Switch to workspace: doomed', '/tmp/doomed'),
  command('workspace-open-path', 'workspace', 'Open workspace…', 'by its path on disk'),
  command('workspace-new', 'workspace', 'New workspace…', 'scaffold and open it'),
  command('workspace-rename:1', 'workspace', 'Rename workspace: The first one', '/tmp/first'),
  command(
    'workspace-forget:1',
    'workspace',
    'Remove workspace from the list: The first one',
    'keeps every file on disk',
  ),
  command('workspace-erase:2', 'workspace', 'Delete workspace from disk: doomed', 'irreversible'),
]

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
    ['delete workspace from disk: doomed', 'workspace-erase:2'],
    ['research', 'ask-research'],
    ['whole article', 'ask-article'],
    ['new article', 'new-article'],
    ['draft brief', 'draft-brief'],
    ['edit strategy', 'edit-strategy'],
    ['draft article', 'draft-article'],
    ['edit brief', 'edit-brief'],
    ['export html', 'export-html'],
    ['From Hugo', 'workspace-open:1'],
    ['open article hello', 'open:hello-openwrite'],
    ['open hello', 'open:hello-openwrite'],
    ['remove workspace from the list: The first one', 'workspace-forget:1'],
    ['run skill diagram', 'skill:diagram'],
    ['settings', 'settings'],
    ['switch to workspace', 'workspace-open:1'],
  ]
  for (const [query, id] of cases) {
    it(`"${query}" → ${id}`, () => {
      expect(orderCommands(filterCommands(REGISTRY, query))[0]?.id).toBe(id)
    })
  }

  it('"new art" matches exactly one command', () => {
    expect(filterCommands(REGISTRY, 'new art')).toHaveLength(1)
  })
})
