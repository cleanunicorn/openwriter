import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-helpers.ts'

// security.test.ts checks the middleware on a throwaway app. This file checks that the REAL app
// (createApp) has it mounted in front of every route: deleting the `app.use('*', localOnly(...))`
// line must fail here. The policy itself is not decided in this file.
let t: TestApp
beforeEach(() => {
  t = createTestApp()
})
afterEach(() => t.cleanup())

const HOST = '127.0.0.1:4317'
const save = (headers: Record<string, string>, body = '{"text":"x","baseHash":null}') =>
  t.app.request('/api/docs/strategy', { method: 'PUT', headers, body })

describe('the local-only guard is mounted on the real app', () => {
  it.each([
    '/api/health',
    '/api/articles',
    '/api/docs/strategy',
    '/api/jobs',
    '/api/config',
    '/api/events',
  ])('a foreign Host is refused on %s', async (url) => {
    expect((await t.app.request(url, { headers: { host: 'evil.example:4317' } })).status).toBe(403)
  })

  it('a cross-origin write is refused', async () => {
    const res = await save({
      host: HOST,
      origin: 'https://evil.example',
      'content-type': 'application/json',
    })
    expect(res.status).toBe(403)
  })

  it('a form-encoded write, which a cross-site form can send, is refused', async () => {
    const res = await save(
      { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      'text=x',
    )
    expect(res.status).toBe(415)
  })

  it('the same write from the app itself goes through to the route', async () => {
    const res = await save({
      host: HOST,
      origin: `http://${HOST}`,
      'content-type': 'application/json',
    })
    // 409: the route ran and found a stale base hash — the guard let it pass.
    expect(res.status).toBe(409)
  })
})
