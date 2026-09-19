import { existsSync, readFileSync, statSync } from 'node:fs'
import type { Hono } from 'hono'
import {
  type DocRef,
  DocRefSchema,
  NewArticleRequestSchema,
  SaveRequestSchema,
} from '../../shared/api-types.ts'
import {
  extensionForImage,
  MAX_ASSET_BYTES,
  sanitiseFileName,
  storeWithoutOverwrite,
} from '../assets.ts'
import type { ServerContext } from '../context.ts'
import { contentTypeFor, HttpError, parseBody } from '../http.ts'
import { resolveWithin } from '../paths.ts'

function refFrom(kind: string, slug: string | undefined): DocRef {
  const parsed = DocRefSchema.safeParse(kind === 'strategy' ? { kind } : { kind, slug })
  if (!parsed.success) throw new HttpError(400, 'invalid document reference')
  return parsed.data
}

export function mountDocRoutes(app: Hono, { workspace, watcher }: ServerContext): void {
  app.get('/api/articles', (c) => c.json({ articles: workspace.listArticles() }))

  app.post('/api/articles', async (c) => {
    const { title } = await parseBody(c, NewArticleRequestSchema)
    return c.json(workspace.createArticle(title), 201)
  })

  app.get('/api/docs/:kind/:slug?', (c) => {
    const ref = refFrom(c.req.param('kind'), c.req.param('slug'))
    const doc = workspace.readDoc(ref)
    watcher.remember(ref, doc.hash)
    return c.json(doc)
  })

  app.put('/api/docs/:kind/:slug?', async (c) => {
    const ref = refFrom(c.req.param('kind'), c.req.param('slug'))
    const { text, baseHash } = await parseBody(c, SaveRequestSchema)
    const hash = workspace.writeDoc(ref, text, baseHash)
    watcher.remember(ref, hash)
    return c.json({ hash })
  })

  // Image paste/drop: the body is the image, the name travels in a header.
  app.post('/api/docs/article/:slug/assets', async (c) => {
    const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const extension = extensionForImage(contentType)
    if (extension === undefined) throw new HttpError(415, 'only images can be pasted or dropped')
    const data = new Uint8Array(await c.req.arrayBuffer())
    if (data.byteLength === 0) throw new HttpError(400, 'empty upload')
    if (data.byteLength > MAX_ASSET_BYTES) throw new HttpError(413, 'image is too large')
    let wanted = 'image'
    try {
      wanted = decodeURIComponent(c.req.header('x-filename') ?? 'image')
    } catch {
      // A malformed header falls back to the default name.
    }
    const safe = sanitiseFileName(wanted, extension).replace(/\.[a-z0-9]+$/, '') + extension
    const name = storeWithoutOverwrite(workspace.bundleDir(c.req.param('slug')), safe, data)
    return c.json({ name }, 201)
  })

  app.get('/api/docs/article/:slug/assets/*', (c) => {
    const prefix = `/api/docs/article/${c.req.param('slug')}/assets/`
    const relative = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length))
    const file = resolveWithin(workspace.bundleDir(c.req.param('slug')), relative)
    if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'asset not found')
    return c.body(readFileSync(file), 200, {
      'content-type': contentTypeFor(file),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
  })
}
