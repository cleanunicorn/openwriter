import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { startServer } from './main.ts'

const workspace = mkdtempSync(path.join(os.tmpdir(), 'openwrite-main-'))
const workspacesFile = path.join(workspace, '..', `openwrite-main-list-${process.pid}.json`)
const workspacesDir = path.join(workspace, '..', `openwrite-main-workspaces-${process.pid}`)
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(workspacesFile, { force: true })
  rmSync(workspacesDir, { recursive: true, force: true })
})

describe('startServer', () => {
  it('binds the loopback interface only and answers on its own host', async () => {
    const server = await startServer({ workspace, workspacesFile, workspacesDir, port: 0 })
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
    const server = await startServer({ workspace, workspacesFile, workspacesDir, port: 0 })
    try {
      expect((await fetch(`${server.url}/api/nope`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

/**
 * The known-workspace list is resolved from `XDG_CONFIG_HOME` in `main()` and nowhere else, so
 * only the real process can prove it: every in-process test injects its own list file.
 */
describe('main()', () => {
  it('keeps the known-workspace list under XDG_CONFIG_HOME', async () => {
    const configHome = mkdtempSync(path.join(os.tmpdir(), 'openwrite-xdg-'))
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, 'main.ts'), '--workspace', workspace, '--port', '0'],
      { env: { ...process.env, XDG_CONFIG_HOME: configHome }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const exited = new Promise<unknown>((resolve) => child.once('exit', resolve))
    try {
      let output = ''
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          if (output.includes('listening on')) resolve()
        })
        child.once('exit', () => reject(new Error(`main() exited early:\n${output}`)))
      })
      const list = JSON.parse(
        readFileSync(path.join(configHome, 'openwrite', 'workspaces.json'), 'utf8'),
      )
      expect(list.entries.map((entry: { path: string }) => entry.path)).toEqual([
        realpathSync(workspace),
      ])
    } finally {
      child.kill('SIGTERM')
      await exited
      rmSync(configHome, { recursive: true, force: true })
    }
  })
})
