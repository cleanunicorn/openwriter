import { z } from 'zod'

/**
 * The three kinds of lowercase, hyphenated names in the project. They share a shape today but
 * mean different things, so each has its own name and its own schema.
 */
const KEBAB = '[a-z0-9][a-z0-9-]*'

/** An article slug: the directory name of a Hugo leaf bundle, and part of URLs and job paths. */
export const SLUG_MAX_LENGTH = 120
export const SlugSchema = z
  .string()
  .regex(new RegExp(`^${KEBAB}$`))
  .max(SLUG_MAX_LENGTH)
export const isSlug = (value: string): boolean => SlugSchema.safeParse(value).success

/** A skill name: the file name of `skills/<name>.md` and the `/name` prefix in the prompt pill. */
export const SKILL_NAME_SOURCE = KEBAB
export const SkillNameSchema = z.string().regex(new RegExp(`^${KEBAB}$`))

/** A herdr session name, as `herdr --session <name>` accepts it. */
export const HERDR_SESSION_SOURCE = KEBAB
export const HerdrSessionSchema = z.string().regex(new RegExp(`^${KEBAB}$`))
