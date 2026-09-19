import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveWithin } from './paths.ts'

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
}
export const MAX_ASSET_BYTES = 25 * 1024 * 1024

export const extensionForImage = (contentType: string): string | undefined =>
  IMAGE_EXTENSIONS[contentType]

/** Reduce any client- or agent-supplied name to a safe file name inside one directory. */
export function sanitiseFileName(name: string, fallbackExtension = ''): string {
  const base = path.basename(name.replaceAll('\\', '/'))
  const extension = path.extname(base).toLowerCase() || fallbackExtension
  const stem =
    path
      .basename(base, path.extname(base))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'file'
  return `${stem.slice(0, 80)}${extension.replace(/[^a-z0-9.]/g, '')}`
}

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * Put `data` into `dir` under `wanted` without ever overwriting: identical content under the
 * same name is reused, a different file gets `name-2.ext`, `name-3.ext`, …
 */
export function storeWithoutOverwrite(dir: string, wanted: string, data: Uint8Array): string {
  mkdirSync(dir, { recursive: true })
  const extension = path.extname(wanted)
  const stem = path.basename(wanted, extension)
  for (let n = 1; ; n++) {
    const name = n === 1 ? wanted : `${stem}-${n}${extension}`
    const target = resolveWithin(dir, name)
    if (!existsSync(target)) {
      writeFileSync(target, data)
      return name
    }
    if (sha(readFileSync(target)) === sha(data)) return name
  }
}
