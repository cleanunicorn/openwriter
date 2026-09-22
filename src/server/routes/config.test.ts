import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWorkspaceHeader, WORKSPACE_HEADER } from '../../shared/api-types.ts'
import { createTestApp, HOST, json, type TestApp } from '../test-helpers.ts'

let t: TestApp
beforeEach(() => {
  t = createTestApp()
})
afterEach(() => t.cleanup())

describe('config', () => {
  it('returns the sample config with the forced adapter', async () => {
    const body = await json(t.get('/api/config'))
    expect(body.config.mainAgent).toBe('fake')
    expect(body.adapterOverride).toBe('fake')
    expect(body.contentOutsideWorkspace).toBe(false)
  })

  it('never overwrites an invalid config file', async () => {
    const file = path.join(t.workspace, '.zen', 'config.json')
    writeFileSync(file, '{ "concurrency": "many" }')
    const body = await json(t.get('/api/config'))
    expect(body.error).toContain('concurrency')
    expect(body.config.concurrency).toBe(3)
    const res = await t.send('PUT', '/api/config', body.config)
    expect(res.status).toBe(409)
    expect(readFileSync(file, 'utf8')).toBe('{ "concurrency": "many" }')
  })

  it('refuses a relative content directory that leaves the workspace, and writes nothing', async () => {
    const file = path.join(t.workspace, '.zen', 'config.json')
    const before = readFileSync(file, 'utf8')
    const { config } = await json(t.get('/api/config'))
    const res = await t.send('PUT', '/api/config', { ...config, contentDir: '../hugo/content' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('use an absolute path')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await t.get('/api/articles')).status).toBe(200)
  })

  it('stays usable when such a value was written by hand, so settings can repair it', async () => {
    writeFileSync(
      path.join(t.workspace, '.zen', 'config.json'),
      JSON.stringify({ contentDir: '../hugo/content' }),
    )
    const body = await json(t.get('/api/config'))
    expect(body.contentDirError).toContain('leaves the workspace')
    expect(body.error).toBeNull()
    expect(await json(t.get('/api/articles'))).toEqual({ articles: [] })
    const repaired = await t.send('PUT', '/api/config', { ...body.config, contentDir: 'content' })
    expect(repaired.status).toBe(200)
    expect((await json(t.get('/api/articles'))).articles).toHaveLength(1)
  })

  // POSIX only: on Windows `chmod` sets the read-only attribute, which does not stop writes into
  // a directory, so the failure this test needs cannot be made there.
  it.skipIf(process.platform === 'win32')(
    'does not report a filesystem failure as a conflict, and leaks no path',
    async () => {
      const { config } = await json(t.get('/api/config'))
      const zen = path.join(t.workspace, '.zen')
      chmodSync(zen, 0o500)
      try {
        const res = await t.send('PUT', '/api/config', { ...config, concurrency: 4 })
        expect(res.status).toBe(500)
        const body = await res.text()
        expect(body).toBe('{"error":"internal error"}')
        expect(body).not.toContain(t.workspace)
      } finally {
        chmodSync(zen, 0o700)
      }
    },
  )

  it('saves a valid config and reports an absolute content directory', async () => {
    const { config } = await json(t.get('/api/config'))
    const outside = path.join(t.workspace, '..', `hugo-${path.basename(t.workspace)}`)
    mkdirSync(outside)
    try {
      const res = await t.send('PUT', '/api/config', {
        ...config,
        mainAgent: 'codex',
        contentDir: outside,
      })
      const body = await json(res)
      expect(body.config.mainAgent).toBe('codex')
      expect(body.contentOutsideWorkspace).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('a config write names the workspace it was made for', () => {
  const put = (app: TestApp, config: unknown, root: string) =>
    app.app.request('/api/config', {
      method: 'PUT',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        [WORKSPACE_HEADER]: encodeWorkspaceHeader(root),
      },
      body: JSON.stringify(config),
    })

  it('is saved when that workspace is the one open', async () => {
    const { config } = await json(t.get('/api/config'))
    const res = await put(t, { ...config, concurrency: 5 }, t.workspace)
    expect(res.status).toBe(200)
    expect((await json(t.get('/api/config'))).config.concurrency).toBe(5)
  })

  it('works for a workspace whose path is not ASCII', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-ț-文章-'))
    const root = path.join(base, 'ciorne 📝')
    cpSync(path.join(import.meta.dirname, '..', '..', '..', 'sample-workspace'), root, {
      recursive: true,
    })
    const uni = createTestApp({ workspace: root })
    try {
      const { config } = await json(uni.get('/api/config'))
      expect((await put(uni, { ...config, concurrency: 6 }, root)).status).toBe(200)
      expect((await json(uni.get('/api/config'))).config.concurrency).toBe(6)
      // Another non-ASCII root is still another workspace.
      expect((await put(uni, config, `${root}-alt`)).status).toBe(409)
    } finally {
      uni.cleanup()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('is refused, and nothing written, when another workspace is open now', async () => {
    const file = path.join(t.workspace, '.zen', 'config.json')
    const before = readFileSync(file, 'utf8')
    const { config } = await json(t.get('/api/config'))
    // Made for a workspace the server has since switched away from (this tab or another).
    const res = await put(t, { ...config, concurrency: 7 }, '/somewhere/else')
    expect(res.status).toBe(409)
    expect((await json(res)).error).toContain('workspace changed')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
