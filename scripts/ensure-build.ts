// Builds dist/client only when it is missing or older than the sources, so `npm start` is fast
// on a daily start and `npm run test:e2e` works from a clean tree (the gate runs it before build).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'dist', 'client', 'index.html')

function newestMtime(target: string): number {
  const stats = statSync(target)
  if (!stats.isDirectory()) return stats.mtimeMs
  return readdirSync(target).reduce(
    (newest, name) => Math.max(newest, newestMtime(path.join(target, name))),
    0,
  )
}

const sources = ['src/client', 'src/shared', 'vite.config.ts', 'package.json'].map((entry) =>
  path.join(root, entry),
)
const stale =
  !existsSync(output) || sources.some((source) => newestMtime(source) > statSync(output).mtimeMs)

if (stale) {
  console.log('openwrite: building the client…')
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const result = spawnSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
