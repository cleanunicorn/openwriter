import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { serve } from '@hono/node-server'
import { SERVER_PORT, VITE_PORT } from '../shared/ports.ts'
import { createApp } from './app.ts'
import { hostsFor } from './security.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export type StartOptions = {
  workspace: string
  /** 0 picks a free port. Undefined tries SERVER_PORT and the ports after it. */
  port?: number
  dev?: boolean
  adapterOverride?: string
  fakeControl?: boolean
}

export type RunningServer = {
  url: string
  port: number
  /** The interface the socket is bound to; always 127.0.0.1. */
  address: string
  close: () => Promise<void>
}

/** Always binds 127.0.0.1 — the server has no auth model, so it must never listen wider. */
function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
): Promise<ReturnType<typeof serve>> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname: '127.0.0.1' })
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  let port = 0
  const app = createApp({
    workspace: options.workspace,
    clientDir: options.dev ? undefined : path.join(REPO_ROOT, 'dist', 'client'),
    adapterOverride: options.adapterOverride,
    fakeControl: options.fakeControl ?? false,
    allowedHosts: () => hostsFor(port, options.dev ? VITE_PORT : undefined),
  })

  const candidates =
    options.port !== undefined
      ? [options.port]
      : Array.from({ length: 20 }, (_, index) => SERVER_PORT + index)
  let server: ReturnType<typeof serve> | undefined
  for (const candidate of candidates) {
    try {
      server = await listen(app.fetch, candidate)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  if (server === undefined) throw new Error(`no free port from ${candidates[0]}`)
  const bound = server.address() as AddressInfo
  port = bound.port
  const running = server
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    address: bound.address,
    close: () => new Promise((resolve) => running.close(() => resolve())),
  }
}

/** First run copies the tracked sample, so playing with the app never dirties what tests copy. */
function defaultWorkspace(): string {
  const copy = path.join(REPO_ROOT, '.openwrite', 'sample-workspace')
  if (!existsSync(copy)) {
    mkdirSync(path.dirname(copy), { recursive: true })
    cpSync(path.join(REPO_ROOT, 'sample-workspace'), copy, { recursive: true })
  }
  return copy
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(command, [url], { stdio: 'ignore', detached: true })
  child.on('error', () => console.log(`Open ${url} in your browser.`))
  child.unref()
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      port: { type: 'string' },
      adapter: { type: 'string' },
      dev: { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      'fake-control': { type: 'boolean', default: false },
    },
  })
  const workspace = path.resolve(
    values.workspace ?? process.env.OPENWRITE_WORKSPACE ?? defaultWorkspace(),
  )
  if (!existsSync(workspace)) throw new Error(`workspace not found: ${workspace}`)
  const port =
    values.port !== undefined ? Number(values.port) : values.dev ? SERVER_PORT : undefined
  const server = await startServer({
    workspace,
    port,
    dev: values.dev,
    adapterOverride: values.adapter,
    fakeControl: values['fake-control'],
  })
  console.log(`openwrite listening on ${server.url}`)
  console.log(`workspace: ${workspace}`)
  if (values.open) openBrowser(server.url)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void server.close().then(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref()
    })
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
