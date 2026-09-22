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
  safeAssetBytes,
  sanitiseFileName,
  storeWithoutOverwrite,
  UnsafeSvgError,
} from '../assets.ts'
import type { ServerContext } from '../context.ts'
import { fileResponse, HttpError, parseBody, pathTail, pinWorkspace } from '../http.ts'
import { resolveWithin } from '../paths.ts'

function refFrom(kind: string, slug: string | undefined): DocRef {
  const parsed = DocRefSchema.safeParse(kind === 'strategy' ? { kind } : { kind, slug })
  if (!parsed.success) throw new HttpError(400, 'invalid document reference')
  return parsed.data
}

/** Read a request body, giving up as soon as it exceeds `limit` (no usable content-length). */
async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new HttpError(413, 'image is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export function mountDocRoutes(app: Hono, { workspace, watcher }: ServerContext): void {
  app.get('/api/articles', (c) => c.json({ articles: workspace.listArticles() }))

  // Every route below that reads or writes a document checks, after its last await, that the
  // workspace it was admitted under is still the one open (`pinWorkspace`).
  app.post('/api/articles', async (c) => {
    const pinned = pinWorkspace(
      c,
      workspace,
      'The workspace changed before the article was created.',
    )
    const { title } = await parseBody(c, NewArticleRequestSchema)
    pinned()
    return c.json(workspace.createArticle(title), 201)
  })

  // A read is pinned too: a tab that has not heard of a switch would otherwise load the other
  // workspace's document of the same slug into its own state, and save its edits there.
  app.get('/api/docs/:kind/:slug?', (c) => {
    const ref = refFrom(c.req.param('kind'), c.req.param('slug'))
    pinWorkspace(c, workspace, 'The workspace changed; this document belongs to another one.')()
    const doc = workspace.readDoc(ref)
    watcher.remember(ref, doc.hash)
    return c.json(doc)
  })

  app.put('/api/docs/:kind/:slug?', async (c) => {
    const ref = refFrom(c.req.param('kind'), c.req.param('slug'))
    const pinned = pinWorkspace(c, workspace, 'The workspace changed before this was saved.')
    const { text, baseHash } = await parseBody(c, SaveRequestSchema)
    pinned()
    const hash = workspace.writeDoc(ref, text, baseHash)
    watcher.remember(ref, hash)
    return c.json({ hash })
  })

  // Image paste/drop: the body is the image, the name travels in a header.
  app.post('/api/docs/article/:slug/assets', async (c) => {
    const pinned = pinWorkspace(c, workspace, 'The workspace changed before the image was stored.')
    const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const extension = extensionForImage(contentType)
    if (extension === undefined) throw new HttpError(415, 'only images can be pasted or dropped')
    // Refuse by the declared length before reading anything: buffering first would let one
    // request occupy as much memory as it likes before the limit applies.
    const declared = Number(c.req.header('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES)
      throw new HttpError(413, 'image is too large')
    const data = await readLimited(c.req.raw, MAX_ASSET_BYTES)
    if (data.byteLength === 0) throw new HttpError(400, 'empty upload')
    let requestedName = 'image'
    try {
      requestedName = decodeURIComponent(c.req.header('x-filename') ?? 'image')
    } catch {
      // A malformed header falls back to the default name.
    }
    // Sanitise, then force the extension the content type declares.
    const fileName = sanitiseFileName(requestedName).replace(/\.[a-z0-9]+$/, '') + extension
    // An SVG is sanitised before it is stored (svg.ts); one that cannot be read safely is refused.
    let safe: ReturnType<typeof safeAssetBytes>
    try {
      safe = safeAssetBytes(fileName, data)
    } catch (error) {
      if (error instanceof UnsafeSvgError) throw new HttpError(400, error.message)
      throw error
    }
    pinned()
    const bundle = workspace.bundleDir(c.req.param('slug'))
    const name = storeWithoutOverwrite(bundle, fileName, safe.data)
    return c.json({ name, removed: safe.removed }, 201)
  })

  app.get('/api/docs/article/:slug/assets/*', (c) => {
    const slug = c.req.param('slug')
    const relative = pathTail(c, `/api/docs/article/${slug}/assets/`)
    const file = resolveWithin(workspace.bundleDir(slug), relative)
    if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'asset not found')
    return fileResponse(c, readFileSync(file), file)
  })
}
