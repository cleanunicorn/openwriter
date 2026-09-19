import type { Context } from 'hono'
import type { z } from 'zod'

/** An error a route wants the client to see, with its status. Everything else is a 500. */
export class HttpError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 415 | 422
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

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.cast': 'application/json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export const contentTypeFor = (file: string): string =>
  CONTENT_TYPES[file.slice(file.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'
