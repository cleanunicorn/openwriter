import { z } from 'zod'
import { ConfigSchema } from './config-schema.ts'
import { ScopeSchema } from './jobs/scope.ts'
import { SlugSchema } from './names.ts'

/** The editor is document-generic: an article, the global strategy, or an article's brief. */
export const DocRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('article'), slug: SlugSchema }),
  z.object({ kind: z.literal('brief'), slug: SlugSchema }),
  z.object({ kind: z.literal('strategy') }),
])
export type DocRef = z.infer<typeof DocRefSchema>

/**
 * A config write names the workspace it was made for. The server has one open workspace at a
 * time and a switch can happen while a write is on its way (this tab or another), so it refuses a
 * write meant for a workspace that is no longer open instead of saving it into the new one.
 */
export const WORKSPACE_HEADER = 'x-openwrite-workspace'

/**
 * The header carries the root URI-encoded: a header value must be ASCII-safe (a ByteString), and a
 * workspace path may hold any character (`ț`, CJK, an emoji). A value that does not decode names
 * no workspace, so it can never match the one that is open.
 */
export const encodeWorkspaceHeader = (root: string): string => encodeURIComponent(root)
export function decodeWorkspaceHeader(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

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

export const SaveRequestSchema = z.object({ text: z.string(), baseHash: z.string().nullable() })
export const SaveResponseSchema = z.object({ hash: z.string() })

export const ArticleSchema = z.object({ slug: SlugSchema, title: z.string() })
export type Article = z.infer<typeof ArticleSchema>
export const ArticlesResponseSchema = z.object({ articles: z.array(ArticleSchema) })
export const NewArticleRequestSchema = z.object({ title: z.string().trim().min(1).max(200) })

export const AssetResponseSchema = z.object({ name: z.string() })

export const ConfigResponseSchema = z.object({
  config: ConfigSchema,
  /** Set when the file on disk is invalid: the server runs on defaults and never overwrites it. */
  error: z.string().nullable(),
  /** Set when `contentDir` cannot be used (a relative path that leaves the workspace). */
  contentDirError: z.string().nullable(),
  /** True when `contentDir` resolves outside the workspace. */
  contentOutsideWorkspace: z.boolean(),
  adapters: z.array(z.string()),
  /** The adapter forced from the command line, if any. */
  adapterOverride: z.string().nullable(),
})
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>

/** Which document a skill's job edits when it is started from the palette. */
export const SkillDocumentSchema = z.enum(['current', 'brief', 'article'])

/** What the palette needs to know about a skill. The prompt body and the permission headers stay on the server. */
export const SkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: ScopeSchema,
  task: z.string().optional(),
  stub: z.boolean(),
  requires: z.array(z.string()),
  document: SkillDocumentSchema,
})
export type SkillInfo = z.infer<typeof SkillInfoSchema>
export const SkillsResponseSchema = z.object({ skills: z.array(SkillInfoSchema) })

export const OkResponseSchema = z.object({ ok: z.boolean() })

/** Export requests; the response is a zip, not JSON. */
export const MarkdownExportRequestSchema = z.object({ slug: SlugSchema })
export const HtmlExportRequestSchema = z.object({
  slug: SlugSchema,
  title: z.string().max(500),
  html: z.string().max(20_000_000),
})
export type MarkdownExportRequest = z.infer<typeof MarkdownExportRequestSchema>
export type HtmlExportRequest = z.infer<typeof HtmlExportRequestSchema>
