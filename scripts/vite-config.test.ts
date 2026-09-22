import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../vite.config.ts'

const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'client')
const proxyKeys = Object.keys(config.server?.proxy ?? {})

/** Vite's rule: a key starting with `^` is a RegExp, any other key a path prefix. */
function proxied(url: string): boolean {
  return proxyKeys.some((key) =>
    key.startsWith('^') ? new RegExp(key).test(url) : url.startsWith(key),
  )
}

describe('dev proxy', () => {
  it('sends API requests to the Node server', () => {
    for (const url of ['/api/config', '/api/events', '/api/jobs/abc/cancel']) {
      expect(proxied(url), url).toBe(true)
    }
  })

  it('leaves every client file to Vite', () => {
    const files = readdirSync(CLIENT_ROOT, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `/${path.relative(CLIENT_ROOT, path.join(entry.parentPath, entry.name))}`)
    expect(files).toContain('/api.ts')
    for (const url of files) expect(proxied(url), url).toBe(false)
  })
})
