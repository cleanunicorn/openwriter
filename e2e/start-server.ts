import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

export type E2eServer = {
  url: string
  /** Absolute path of the server's own temp copy of the sample workspace. */
  workspace: string
  child: ChildProcess
}

/**
 * Start `scripts/e2e-server.ts` on a free port with the fake-control routes. Resolves once the
 * server has printed where it listens and which workspace it serves: those two lines are the
 * startup contract, and this is the one place that parses them.
 */
export function startE2eServer(): Promise<E2eServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'e2e-server.ts'), '--port', '0', '--fake-control'],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const url = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      const workspace = output.match(/workspace: (.+)/)?.[1]?.trim()
      if (url !== undefined && workspace !== undefined) resolve({ url, workspace, child })
    })
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.once('exit', (code) => reject(new Error(`e2e server exited early (${code})\n${output}`)))
  })
}
