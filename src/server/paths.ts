import { realpathSync } from 'node:fs'
import path from 'node:path'

/** Thrown for every path that would leave its root. Routes map it to HTTP 400. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function assertSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug) || slug.length > 120) {
    throw new PathEscapeError(`invalid slug: ${JSON.stringify(slug)}`)
  }
  return slug
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

/** realpath of the nearest ancestor that exists, so a symlinked parent cannot hide an escape. */
function realpathOfNearestExisting(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) return target
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Resolve `segments` under `root` and refuse anything that escapes it: NUL bytes, absolute
 * segments, `..`, percent-encoded traversal, sibling-prefix tricks, and symlinks (checked on the
 * nearest existing ancestor, so it also covers paths that are about to be created).
 * Call it at use time, right before the filesystem operation.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  // The root itself may not exist yet (a freshly configured content directory).
  const realRoot = realpathOfNearestExisting(path.resolve(root))
  for (const segment of segments) {
    if (segment.includes('\0')) throw new PathEscapeError('NUL byte in path')
    if (path.isAbsolute(segment) || /^[a-zA-Z]:[\\/]/.test(segment)) {
      throw new PathEscapeError(`absolute path not allowed: ${segment}`)
    }
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new PathEscapeError(`malformed encoding: ${segment}`)
    }
    for (const form of [segment, decoded]) {
      if (form.split(/[\\/]/).includes('..')) throw new PathEscapeError(`traversal: ${segment}`)
    }
  }
  const lexical = path.resolve(realRoot, ...segments)
  if (!isInside(realRoot, lexical)) throw new PathEscapeError(`escapes root: ${segments.join('/')}`)
  const real = realpathOfNearestExisting(lexical)
  if (!isInside(realRoot, real))
    throw new PathEscapeError(`symlink escapes root: ${segments.join('/')}`)
  return lexical
}
