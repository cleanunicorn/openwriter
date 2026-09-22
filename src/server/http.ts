import type { Context } from 'hono'
import type { z } from 'zod'
import { decodeWorkspaceHeader, WORKSPACE_HEADER } from '../shared/api-types.ts'
import { IMAGE_EXTENSIONS, safeAssetBytes, UnsafeSvgError } from './assets.ts'

/** An error a route wants the client to see, with its status. Everything else is a 500. */
export class HttpError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 415
  readonly body: Record<string, unknown>
  constructor(status: HttpError['status'], message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** zod at the boundary: every request body is parsed before a route touches it. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    throw new HttpError(400, 'body is not valid JSON')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new HttpError(400, `invalid body: ${issue?.path.join('.')} ${issue?.message}`)
  }
  return parsed.data
}

/**
 * Pin a request to the workspace that was open when it arrived, and to the one the client says it
 * is for. Call it before the first `await` and run the check it returns after the last one, right
 * before the handler reads or writes: a switch can complete while the body is still arriving, and
 * `Workspace.retarget` moves the shared object in place, so without this the handler would resume
 * against the new root. A document's base-hash guard does not cover it: a file absent from both
 * workspaces has a null hash in each, and `null !== null` is false.
 *
 * The header is optional (a request typed by hand has none); the admitted root is not.
 */
export function pinWorkspace(
  c: Context,
  workspace: { readonly root: string },
  message = 'The workspace changed before this request was carried out.',
): () => void {
  const admitted = workspace.root
  const header = c.req.header(WORKSPACE_HEADER)
  const named = header === undefined ? admitted : decodeWorkspaceHeader(header)
  return () => {
    if (workspace.root !== admitted || named !== workspace.root) {
      throw new HttpError(409, message, { workspaceChanged: true })
    }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  // Every image that can be uploaded is served back under the type it arrived with.
  ...Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([type, ext]) => [ext, type])),
  '.jpeg': 'image/jpeg',
  '.cast': 'application/json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

function contentTypeFor(file: string): string {
  const dot = file.lastIndexOf('.')
  // Not path.extname: a dotfile such as `.png` is served by its name.
  const extension = dot === -1 ? '' : file.slice(dot).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/** The part of the request path after `prefix`, decoded. A malformed escape is the client's error (400), not ours (500). */
export function pathTail(c: Context, prefix: string): string {
  try {
    return decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length))
  } catch {
    throw new HttpError(400, 'malformed percent-escape in the path')
  }
}

/**
 * Answer with a file from the workspace. Assets can be anything an agent or the writer put
 * there, so they are never sniffed and never allowed to run anything when opened directly. An
 * SVG is sanitised on the way out as well as on the way in: a job's assets and a file copied into
 * a bundle by hand never went through the upload.
 */
export function fileResponse(c: Context, data: Uint8Array, name: string): Response {
  let body: Uint8Array
  try {
    body = safeAssetBytes(name, data).data
  } catch (error) {
    if (error instanceof UnsafeSvgError) throw new HttpError(415, error.message)
    throw error
  }
  return c.body(new Uint8Array(body), 200, {
    'content-type': contentTypeFor(name),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
}
