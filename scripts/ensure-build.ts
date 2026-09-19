// Builds dist/client only when it is missing or older than the sources, so `npm start` is fast
// on a daily start and `npm run test:e2e` works from a clean tree (the gate runs it before build).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Newest modification time under `target`. A directory's own mtime counts: it changes when an
 * entry is deleted or renamed, which no remaining file's mtime would show — without it a deleted
 * source file would leave the old bundle, still containing its code, looking fresh.
 */
export function newestMtime(target: string): number {
  const stats = statSync(target)
  if (!stats.isDirectory()) return stats.mtimeMs
  return readdirSync(target).reduce(
    (newest, name) => Math.max(newest, newestMtime(path.join(target, name))),
    stats.mtimeMs,
  )
}

export function isStale(output: string, sources: string[]): boolean {
  if (!existsSync(output)) return true
  const built = statSync(output).mtimeMs
  return sources.some((source) => newestMtime(source) > built)
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, '..')
  const output = path.join(root, 'dist', 'client', 'index.html')
  const sources = ['src/client', 'src/shared', 'vite.config.ts', 'package.json'].map((entry) =>
    path.join(root, entry),
  )
  if (isStale(output, sources)) {
    console.log('openwrite: building the client…')
    const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
    const result = spawnSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' })
    process.exit(result.status ?? 1)
  }
}
