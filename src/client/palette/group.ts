/**
 * The command taxonomy, pure so it can be unit-tested: the palette and the left panel both render
 * commands through it, so a command lands in the same section everywhere.
 */

export const GROUP_ORDER = ['documents', 'agent', 'export', 'workspace', 'app'] as const
export type CommandGroup = (typeof GROUP_ORDER)[number]

const GROUP_LABELS: Record<CommandGroup, string> = {
  documents: 'Documents',
  agent: 'Agent',
  export: 'Export',
  workspace: 'Workspace',
  app: 'App',
}

export type Command = {
  id: string
  title: string
  hint?: string
  group: CommandGroup
  run: () => void | Promise<void>
}

/** A provider whose commands all belong to one group says so once. */
export const inGroup = (group: CommandGroup, commands: Omit<Command, 'group'>[]): Command[] =>
  commands.map((command) => ({ ...command, group }))

export type CommandSection = { group: CommandGroup; label: string; commands: Command[] }

/** Every word of the query must appear in the title or the hint, in any order. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((command) => {
    const haystack = `${command.title} ${command.hint ?? ''}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** Sections in `GROUP_ORDER`, commands in registration order within each; empty groups omitted. */
export function groupCommands(commands: Command[]): CommandSection[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    commands: commands.filter((command) => command.group === group),
  })).filter((section) => section.commands.length > 0)
}
