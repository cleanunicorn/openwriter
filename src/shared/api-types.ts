import { z } from 'zod'
import { ConfigSchema } from './config-schema.ts'

const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(120)

/** The editor is document-generic: an article, the global strategy, or an article's brief. */
export const DocRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('article'), slug: Slug }),
  z.object({ kind: z.literal('brief'), slug: Slug }),
  z.object({ kind: z.literal('strategy') }),
])
export type DocRef = z.infer<typeof DocRefSchema>

export const docKey = (ref: DocRef): string =>
  ref.kind === 'strategy' ? 'strategy' : `${ref.kind}:${ref.slug}`

export const docUrl = (ref: DocRef): string =>
  ref.kind === 'strategy' ? '/api/docs/strategy' : `/api/docs/${ref.kind}/${ref.slug}`

/** `hash` is null when the file does not exist. */
export const DocResponseSchema = z.object({
  text: z.string(),
  hash: z.string().nullable(),
  exists: z.boolean(),
})
export type DocResponse = z.infer<typeof DocResponseSchema>

export const SaveRequestSchema = z.object({ text: z.string(), baseHash: z.string().nullable() })
export const SaveResponseSchema = z.object({ hash: z.string() })

export const ArticleSchema = z.object({ slug: Slug, title: z.string() })
export type Article = z.infer<typeof ArticleSchema>
export const ArticlesResponseSchema = z.object({ articles: z.array(ArticleSchema) })
export const NewArticleRequestSchema = z.object({ title: z.string().trim().min(1).max(200) })

export const AssetResponseSchema = z.object({ name: z.string() })

export const ConfigResponseSchema = z.object({
  config: ConfigSchema,
  /** Set when the file on disk is invalid: the server runs on defaults and never overwrites it. */
  error: z.string().nullable(),
  /** True when `contentDir` resolves outside the workspace. */
  contentOutsideWorkspace: z.boolean(),
  adapters: z.array(z.string()),
  /** The adapter forced from the command line, if any. */
  adapterOverride: z.string().nullable(),
})
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>
