import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from './main.ts'

const workspace = mkdtempSync(path.join(os.tmpdir(), 'openwrite-main-'))
afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe('startServer', () => {
  it('binds the loopback interface only and answers on its own host', async () => {
    const server = await startServer({ workspace, port: 0 })
    try {
      expect(server.address).toBe('127.0.0.1')
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
      const res = await fetch(`${server.url}/api/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })
    } finally {
      await server.close()
    }
  })

  it('answers 404 for unknown API routes', async () => {
    const server = await startServer({ workspace, port: 0 })
    try {
      expect((await fetch(`${server.url}/api/nope`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
