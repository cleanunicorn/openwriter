import os from 'node:os'
import type { MiddlewareHandler } from 'hono'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The server has no auth model: local access is the boundary. Binding to 127.0.0.1 keeps other
 * machines out, but a web page open in the writer's browser can still reach the loopback API.
 * This middleware closes that vector: the Host must be ours (DNS rebinding), a non-GET with an
 * Origin must be same-origin (CSRF), and a mutating request must carry a content type that a
 * cross-site form cannot send without a CORS preflight. No CORS headers are ever sent.
 */
export function localOnly(allowedHosts: () => string[]): MiddlewareHandler {
  return async (c, next) => {
    const allowed = allowedHosts()
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!allowed.includes(host)) return c.json({ error: 'forbidden host' }, 403)

    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin')
      if (origin !== undefined) {
        let originHost = ''
        try {
          originHost = new URL(origin).host
        } catch {
          return c.json({ error: 'forbidden origin' }, 403)
        }
        if (!allowed.includes(originHost)) return c.json({ error: 'forbidden origin' }, 403)
      }
      const contentType = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? ''
      const isUpload = contentType.startsWith('image/')
      if (contentType !== 'application/json' && !isUpload) {
        return c.json({ error: 'unsupported content type' }, 415)
      }
    }
    await next()
  }
}

/**
 * Hosts the API answers to. The Vite origin is accepted only in the dev flow, where Vite listens
 * on every interface: then each LAN address at the Vite port is ours too. Hostnames other than
 * `localhost` stay rejected, which keeps the DNS-rebinding check.
 */
export function hostsFor(port: number, devVitePort?: number, lan: string[] = []): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (devVitePort === undefined) return hosts
  hosts.push(`127.0.0.1:${devVitePort}`, `localhost:${devVitePort}`)
  for (const address of lan) {
    hosts.push(address.includes(':') ? `[${address}]:${devVitePort}` : `${address}:${devVitePort}`)
  }
  return hosts
}

/** This machine's non-loopback addresses, read per call so a DHCP change needs no restart. */
export function lanAddresses(): string[] {
  return (
    Object.values(os.networkInterfaces())
      .flat()
      .filter((info): info is os.NetworkInterfaceInfo => info !== undefined && !info.internal)
      // A zoned IPv6 link-local address cannot appear in a browser's Host header.
      .filter((info) => info.family === 'IPv4' || info.scopeid === 0)
      .map((info) => info.address)
  )
}
