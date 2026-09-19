import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { hostsFor, localOnly } from './security.ts'

function appWith(hosts: string[]) {
  const app = new Hono()
  app.use(
    '*',
    localOnly(() => hosts),
  )
  app.get('/x', (c) => c.text('ok'))
  app.post('/x', (c) => c.text('ok'))
  return app
}

const json = { 'content-type': 'application/json' }

describe('localOnly', () => {
  const app = appWith(hostsFor(4317))

  it('accepts a loopback host', async () => {
    const res = await app.request('/x', { headers: { host: '127.0.0.1:4317' } })
    expect(res.status).toBe(200)
  })

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const res = await app.request('/x', { headers: { host: 'evil.example:4317' } })
    expect(res.status).toBe(403)
  })

  it('rejects a cross-origin POST', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { host: '127.0.0.1:4317', origin: 'https://evil.example', ...json },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  it('accepts a same-origin JSON POST', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', ...json },
      body: '{}',
    })
    expect(res.status).toBe(200)
  })

  it('rejects a form-encoded POST, which a cross-site form could send', async () => {
    const res = await app.request('/x', {
      method: 'POST',
      headers: { host: '127.0.0.1:4317', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    })
    expect(res.status).toBe(415)
  })

  it('never sends CORS headers', async () => {
    const res = await app.request('/x', { headers: { host: '127.0.0.1:4317' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('dev origin', () => {
  const viaVite = {
    method: 'POST',
    headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', ...json },
    body: '{}',
  }

  it('is rejected in production', async () => {
    expect((await appWith(hostsFor(4317)).request('/x', viaVite)).status).toBe(403)
  })

  it('is accepted only when the dev flow adds it', async () => {
    expect((await appWith(hostsFor(4317, 5173)).request('/x', viaVite)).status).toBe(200)
  })
})
