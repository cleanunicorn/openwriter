import { existsSync } from 'node:fs'
import type { Hono } from 'hono'
import { HtmlExportRequestSchema, MarkdownExportRequestSchema } from '../../shared/api-types.ts'
import type { ServerContext } from '../context.ts'
import { htmlZip, markdownZip } from '../export.ts'
import { HttpError, parseBody, pinWorkspace } from '../http.ts'

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

  // Pinned like a document read: an export asked for in one workspace never zips the other's article.
  app.post('/api/export/markdown', async (c) => {
    const pinned = pinWorkspace(c, workspace, 'The workspace changed before the export.')
    const { slug } = await parseBody(c, MarkdownExportRequestSchema)
    pinned()
    return zipResponse(markdownZip(bundleOf(slug), slug), `${slug}-markdown.zip`)
  })

  app.post('/api/export/html', async (c) => {
    const pinned = pinWorkspace(c, workspace, 'The workspace changed before the export.')
    const { slug, title, html } = await parseBody(c, HtmlExportRequestSchema)
    pinned()
    return zipResponse(htmlZip(bundleOf(slug), slug, title, html), `${slug}-html.zip`)
  })
}
