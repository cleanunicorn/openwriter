// Starts the production server on a fresh temp copy of the sample workspace with the fake adapter.
// Used by Playwright's webServer (smoke) and, through e2e/start-server.ts, by e2e/fixtures.ts (one
// server per test) and scripts/screenshots.ts. start-server.ts parses the two lines printed below.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { startServer } from '../src/server/main.ts'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '0' },
    'fake-control': { type: 'boolean', default: false },
  },
})

const root = path.resolve(import.meta.dirname, '..')
const workspace = mkdtempSync(path.join(os.tmpdir(), 'openwrite-e2e-'))
cpSync(path.join(root, 'sample-workspace'), workspace, { recursive: true })

const server = await startServer({
  workspace,
  port: Number(values.port),
  adapterOverride: 'fake',
  fakeControl: values['fake-control'],
  // Deterministic on every machine: the recording skill's tools count as missing, as in CI.
  toolLookup: () => false,
})
console.log(`openwrite listening on ${server.url}`)
console.log(`workspace: ${workspace}`)

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  setTimeout(() => process.exit(0), 3500).unref()
  await server.close()
  rmSync(workspace, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
