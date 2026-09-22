import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveWithin } from './paths.ts'
import { isSvgName, sanitiseSvg } from './svg.ts'

/** Content type → extension for every image that can be pasted or dropped; http.ts serves them back by the inverse. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
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
export function sanitiseFileName(name: string): string {
  const base = path.basename(name.replaceAll('\\', '/'))
  const extension = path.extname(base).toLowerCase()
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

/** An SVG that the sanitiser refused, with the reason in words the writer can act on. */
export class UnsafeSvgError extends Error {
  readonly reason: string
  constructor(name: string, reason: string) {
    super(`${name} was refused as an unsafe SVG: ${reason}`)
    this.reason = reason
  }
}

/**
 * The bytes to store or serve for a file called `name`: an SVG goes through the allow-list
 * sanitiser (`svg.ts`) and comes back rewritten, with what it lost; any other file is unchanged.
 * An SVG that cannot be read safely throws `UnsafeSvgError`.
 */
export function safeAssetBytes(
  name: string,
  data: Uint8Array,
): { data: Uint8Array; removed: string[] } {
  if (!isSvgName(name)) return { data, removed: [] }
  const verdict = sanitiseSvg(data)
  if (!verdict.ok) throw new UnsafeSvgError(path.basename(name), verdict.reason)
  return { data: Buffer.from(verdict.svg, 'utf8'), removed: verdict.removed }
}
