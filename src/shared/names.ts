import { z } from 'zod'

/**
 * The kinds of lowercase, hyphenated names in the project. They share a shape today but
 * mean different things, so each has its own name and its own schema.
 */
const KEBAB = '[a-z0-9][a-z0-9-]*'

/** An article slug: the directory name of a Hugo leaf bundle, and part of URLs and job paths. */
const SLUG_MAX_LENGTH = 120
export const SlugSchema = z
  .string()
  .regex(new RegExp(`^${KEBAB}$`))
  .max(SLUG_MAX_LENGTH)
export const isSlug = (value: string): boolean => SlugSchema.safeParse(value).success

/**
 * A workspace name: the directory the server creates under its own workspaces folder. Kebab case
 * cannot spell `..`, a separator, an absolute path or a NUL byte, so a name can never leave it.
 */
const WORKSPACE_NAME_MAX_LENGTH = 64
export const WorkspaceNameSchema = z
  .string()
  .regex(new RegExp(`^${KEBAB}$`), 'use lowercase letters, digits and hyphens only')
  .max(WORKSPACE_NAME_MAX_LENGTH)

/** A skill name: the file name of `skills/<name>.md` and the `/name` prefix in the prompt pill. */
export const SKILL_NAME_SOURCE = KEBAB
export const SkillNameSchema = z.string().regex(new RegExp(`^${KEBAB}$`))

/** A herdr session name, as `herdr --session <name>` accepts it. */
export const HERDR_SESSION_SOURCE = KEBAB
export const HerdrSessionSchema = z.string().regex(new RegExp(`^${KEBAB}$`))
