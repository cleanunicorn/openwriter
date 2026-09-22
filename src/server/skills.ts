import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { type ZodError, z } from 'zod'
import { SkillDocumentSchema, type SkillProblem } from '../shared/api-types.ts'
import { ScopeSchema } from '../shared/jobs/scope.ts'
import { splitHeader } from '../shared/key-values.ts'
import { SkillNameSchema } from '../shared/names.ts'
import { PathEscapeError, resolveWithin } from './paths.ts'

const stringList = z
  .union([z.array(z.string()), z.string().transform((value) => [value])])
  .default([])
/**
 * An `allow:` entry is a tool name with an optional rule — `Bash(asciinema *)`. It is spliced
 * into the agent's command line after a variadic flag, so anything that starts with `-` would be
 * read as a flag of its own (`--add-dir /` would undo the directory confinement).
 */
export const ALLOW_ENTRY = /^[A-Za-z][A-Za-z0-9_]*(\([^()]*\))?$/
const allowList = stringList.pipe(
  z.array(z.string().regex(ALLOW_ENTRY, 'must look like Tool or Tool(rule)')),
)

const flag = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
  .default(false)

/** The header of `skills/<name>.md`. A new media type is a file here, never new editor code. */
export const SkillHeaderSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1),
  scope: ScopeSchema.default('blocks'),
  /** Task kind; selects a per-task agent override from settings (for example `image`). */
  task: z.string().optional(),
  /** Extra tool allowances the adapter may grant, e.g. `Bash(asciinema *)`. */
  allow: allowList,
  network: flag,
  /** Command-line tools that must be on PATH; checked before an agent is started. */
  requires: stringList,
  stub: flag,
  /** Which document the job edits when it is started from the palette. */
  document: SkillDocumentSchema.default('current'),
})

/** `shipped`: `skills/` in this repository. `workspace`: `<workspace>/.zen/skills/`. */
export type SkillSource = 'shipped' | 'workspace'
export type Skill = z.infer<typeof SkillHeaderSchema> & { body: string; source: SkillSource }

export const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '..', 'skills')
/** Where a workspace keeps its own skills, relative to the workspace root. */
export const LOCAL_SKILLS_DIR = ['.zen', 'skills'] as const
/** A skill is a prompt, not a document: anything larger is a mistake, not a template. */
export const MAX_SKILL_BYTES = 64 * 1024
/** More files than this in `.zen/skills/` are reported, not read. */
export const MAX_LOCAL_SKILLS = 100

export function parseSkill(text: string, source: SkillSource = 'shipped'): Skill {
  const { header, body } = splitHeader(text)
  return { ...SkillHeaderSchema.parse(header), body: body.trim(), source }
}

/** The shipped skills. They are reviewed code: a malformed one throws, and a test catches it. */
export function listSkills(dir = SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => parseSkill(readFileSync(path.join(dir, file), 'utf8')))
}

/** What the writer can run, and every workspace skill file that could not be loaded, and why. */
export type SkillCatalog = { skills: Skill[]; errors: SkillProblem[] }

const displayPath = (file?: string) => [...LOCAL_SKILLS_DIR, ...(file ? [file] : [])].join('/')

/** Zod's issues as one line a writer can act on: `scope: Invalid option …; name: Required`. */
function describeHeaderError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'header'}: ${issue.message}`)
    .join('; ')
}

class SkillFileError extends Error {}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Read one `.zen/skills/<file>` without leaving the workspace. The path guard refuses a link
 * whose target is outside it; the real path it vouched for is opened without following a final
 * link (a swap after the check is refused, not followed) and without blocking on a FIFO; and only
 * a regular, singly linked file of at most `MAX_SKILL_BYTES` of UTF-8 is read.
 */
function readLocalSkillFile(root: string, file: string): string {
  let real: string
  try {
    real = realpathSync(resolveWithin(root, ...LOCAL_SKILLS_DIR, file))
  } catch (error) {
    if (error instanceof PathEscapeError) {
      throw new SkillFileError('it is a link to somewhere outside the workspace')
    }
    throw new SkillFileError(`it cannot be read (${(error as NodeJS.ErrnoException).code})`)
  }
  let fd: number
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new SkillFileError(
      code === 'ELOOP' ? 'it turned into a link while it was read' : `it cannot be read (${code})`,
    )
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) throw new SkillFileError('it is not a regular file')
    if (stats.nlink !== 1) throw new SkillFileError('it is a hard link; copy the file instead')
    if (stats.size > MAX_SKILL_BYTES) {
      throw new SkillFileError(
        `it is ${Math.ceil(stats.size / 1024)} KiB; a skill may be at most ${MAX_SKILL_BYTES / 1024} KiB`,
      )
    }
    try {
      return UTF8.decode(readFileSync(fd))
    } catch {
      throw new SkillFileError('it is not UTF-8 text')
    }
  } finally {
    closeSync(fd)
  }
}

/** One workspace skill file, checked against the shipped names. Returns the skill or why not. */
function loadLocalSkill(root: string, file: string, shipped: Set<string>): Skill | string {
  const name = file.slice(0, -'.md'.length)
  if (!SkillNameSchema.safeParse(name).success) {
    return 'the file name must be lowercase letters, digits and hyphens, like my-skill.md'
  }
  let text: string
  try {
    text = readLocalSkillFile(root, file)
  } catch (error) {
    if (error instanceof SkillFileError) return error.message
    throw error
  }
  const { header, body } = splitHeader(text)
  if (Object.keys(header).length === 0) {
    return 'it has no header: start it with a --- block that sets name: and description:'
  }
  const parsed = SkillHeaderSchema.safeParse(header)
  if (!parsed.success) return describeHeaderError(parsed.error)
  const skill: Skill = { ...parsed.data, body: body.trim(), source: 'workspace' }
  if (skill.name !== name) return `the header says name: ${skill.name}, but the file is ${file}`
  // See DECISIONS.md, "Workspace skills": a shipped name always means the shipped skill.
  if (shipped.has(name)) {
    return `a shipped skill is already called "${name}"; rename this file to use it`
  }
  // A workspace skill cannot widen the agent's command line; only a reviewed skills/ file can.
  if (skill.allow.length > 0) {
    return 'allow: is only honoured in the shipped skills/ folder; remove it from a workspace skill'
  }
  if (skill.network) {
    return 'network: true is only honoured in the shipped skills/ folder; remove it from a workspace skill'
  }
  if (body.trim() === '') return 'it has a header but no prompt below it'
  return skill
}

/**
 * The workspace's own skills from `<root>/.zen/skills/*.md`. Nothing here throws for a bad file:
 * each one becomes an entry in `errors` with the reason, and the valid files still load. Other
 * files in the folder (a README.txt, dotfiles) are not skills and are ignored.
 */
export function listLocalSkills(root: string, shipped: Set<string> = new Set()): SkillCatalog {
  const skills: Skill[] = []
  const errors: SkillProblem[] = []
  let dir: string
  try {
    dir = resolveWithin(root, ...LOCAL_SKILLS_DIR)
  } catch (error) {
    if (!(error instanceof PathEscapeError)) throw error
    const reason =
      'it is a link to somewhere outside the workspace; no workspace skills were loaded'
    return { skills, errors: [{ file: displayPath(), error: reason }] }
  }
  let entries: string[]
  try {
    if (!statSync(dir).isDirectory()) {
      return { skills, errors: [{ file: displayPath(), error: 'it is not a folder' }] }
    }
    entries = readdirSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { skills, errors }
    return { skills, errors: [{ file: displayPath(), error: `it cannot be read (${code})` }] }
  }
  const files = entries.filter((file) => file.endsWith('.md') && !file.startsWith('.')).sort()
  for (const [index, file] of files.entries()) {
    if (index >= MAX_LOCAL_SKILLS) {
      errors.push({
        file: displayPath(file),
        error: `only the first ${MAX_LOCAL_SKILLS} skill files are read`,
      })
      continue
    }
    const loaded = loadLocalSkill(root, file, shipped)
    if (typeof loaded === 'string') errors.push({ file: displayPath(file), error: loaded })
    else skills.push(loaded)
  }
  return { skills, errors }
}

/**
 * Every skill the writer can run in this workspace: the shipped ones, then the workspace's own.
 * `root` is read at call time, so the list follows a workspace switch without being told.
 */
export function loadSkills(root?: string, dir = SKILLS_DIR): SkillCatalog {
  const shipped = listSkills(dir)
  if (root === undefined) return { skills: shipped, errors: [] }
  const local = listLocalSkills(root, new Set(shipped.map((skill) => skill.name)))
  return { skills: [...shipped, ...local.skills], errors: local.errors }
}

/** A runnable skill by name, shipped or from the workspace at `root`; never a file that failed. */
export const findSkill = (name: string, root?: string, dir = SKILLS_DIR): Skill | undefined =>
  loadSkills(root, dir).skills.find((skill) => skill.name === name)

/** A cheap fingerprint of what the palette would show; the watcher emits only when it changes. */
export const catalogSignature = (catalog: SkillCatalog): string =>
  JSON.stringify([
    catalog.skills.map(({ body: _body, ...info }) => info),
    catalog.errors,
    // A changed body changes what runs but not what is listed: no event for it.
  ])

export type ToolLookup = (tool: string) => boolean

/**
 * Is `tool` on this PATH? On Windows a program is found by its name plus one of `PATHEXT`'s
 * extensions (`agg` is `agg.exe`), so each is tried; elsewhere the name is the file.
 */
export function findOnPath(
  tool: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32'
  const extensions = windows
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')]
    : ['']
  return (env.PATH ?? env.Path ?? '')
    .split(windows ? ';' : ':')
    .some(
      (dir) => dir !== '' && extensions.some((ext) => existsSync(path.join(dir, `${tool}${ext}`))),
    )
}

/** Is `tool` an executable on PATH? Injected in tests, so nothing has to be installed. */
const onPath: ToolLookup = (tool) => findOnPath(tool, process.env)

export const missingTools = (skill: Skill, lookup: ToolLookup = onPath): string[] =>
  skill.requires.filter((tool) => !lookup(tool))
