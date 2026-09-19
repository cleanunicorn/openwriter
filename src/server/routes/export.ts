import { existsSync } from 'node:fs'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { ServerContext } from '../context.ts'
import { htmlZip, markdownZip } from '../export.ts'
import { HttpError, parseBody } from '../http.ts'

const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(120)
const MarkdownExport = z.object({ slug: Slug })
const HtmlExport = z.object({
  slug: Slug,
  title: z.string().max(500),
  html: z.string().max(20_000_000),
})

export function mountExportRoutes(app: Hono, { workspace }: ServerContext): void {
  const zipResponse = (data: Uint8Array, name: string) =>
    new Response(data, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${name}"`,
      },
    })
  const bundleOf = (slug: string) => {
    const dir = workspace.bundleDir(slug)
    if (!existsSync(dir)) throw new HttpError(404, 'article not found')
    return dir
  }

  app.post('/api/export/markdown', async (c) => {
    const { slug } = await parseBody(c, MarkdownExport)
    return zipResponse(markdownZip(bundleOf(slug), slug), `${slug}-markdown.zip`)
  })

  app.post('/api/export/html', async (c) => {
    const { slug, title, html } = await parseBody(c, HtmlExport)
    return zipResponse(htmlZip(bundleOf(slug), slug, title, html), `${slug}-html.zip`)
  })
}
