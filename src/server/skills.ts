import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { splitHeader } from '../shared/key-values.ts'
import { SkillNameSchema } from '../shared/names.ts'

const list = z.union([z.array(z.string()), z.string().transform((value) => [value])]).default([])
/**
 * An `allow:` entry is a tool name with an optional rule — `Bash(asciinema *)`. It is spliced
 * into the agent's command line after a variadic flag, so anything that starts with `-` would be
 * read as a flag of its own (`--add-dir /` would undo the directory confinement).
 */
export const ALLOW_ENTRY = /^[A-Za-z][A-Za-z0-9_]*(\([^()]*\))?$/
const allowList = list.pipe(
  z.array(z.string().regex(ALLOW_ENTRY, 'must look like Tool or Tool(rule)')),
)

const flag = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
  .default(false)

/** The header of `skills/<name>.md`. A new media type is a file here, never new editor code. */
export const SkillHeaderSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1),
  scope: z.enum(['blocks', 'article', 'research']).default('blocks'),
  /** Task kind; selects a per-task agent override from settings (for example `image`). */
  task: z.string().optional(),
  /** Extra tool allowances the adapter may grant, e.g. `Bash(asciinema *)`. */
  allow: allowList,
  network: flag,
  /** Command-line tools that must be on PATH; checked before an agent is started. */
  requires: list,
  stub: flag,
  /** Which document the job edits when it is started from the palette. */
  document: z.enum(['current', 'brief', 'article']).default('current'),
})
export type Skill = z.infer<typeof SkillHeaderSchema> & { body: string }

export const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..', 'skills')

export function parseSkill(text: string): Skill {
  const { header, body } = splitHeader(text)
  return { ...SkillHeaderSchema.parse(header), body: body.trim() }
}

export function listSkills(dir = SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => parseSkill(readFileSync(path.join(dir, file), 'utf8')))
}

export const findSkill = (name: string, dir = SKILLS_DIR): Skill | undefined =>
  listSkills(dir).find((skill) => skill.name === name)

export type ToolLookup = (tool: string) => boolean

/** Is `tool` an executable on PATH? Injected in tests, so nothing has to be installed. */
export const onPath: ToolLookup = (tool) =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir !== '' && existsSync(path.join(dir, tool)))

export const missingTools = (skill: Skill, lookup: ToolLookup = onPath): string[] =>
  skill.requires.filter((tool) => !lookup(tool))
