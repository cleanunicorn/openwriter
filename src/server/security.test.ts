import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { hostsFor, lanAddresses, localOnly } from './security.ts'

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

describe('dev on every interface', () => {
  const dev = appWith(hostsFor(4317, 5173, ['192.168.1.20', 'fd00::20']))
  const fromLan = (host: string) => ({
    method: 'POST',
    headers: { host, origin: `http://${host}`, ...json },
    body: '{}',
  })

  it('accepts a LAN address at the Vite port', async () => {
    expect((await dev.request('/x', fromLan('192.168.1.20:5173'))).status).toBe(200)
    expect((await dev.request('/x', fromLan('[fd00::20]:5173'))).status).toBe(200)
  })

  it('rejects a LAN address at the API port, which is never exposed', async () => {
    expect((await dev.request('/x', fromLan('192.168.1.20:4317'))).status).toBe(403)
  })

  it('still rejects a foreign hostname (DNS rebinding)', async () => {
    expect((await dev.request('/x', fromLan('evil.example:5173'))).status).toBe(403)
  })

  it('ignores LAN addresses outside the dev flow', () => {
    expect(hostsFor(4317, undefined, ['192.168.1.20'])).toEqual([
      '127.0.0.1:4317',
      'localhost:4317',
    ])
  })
})

describe('lanAddresses', () => {
  it('lists no loopback or zoned address', () => {
    for (const address of lanAddresses()) {
      expect(address).not.toMatch(/^(127\.|::1$|fe80:)/)
    }
  })
})
