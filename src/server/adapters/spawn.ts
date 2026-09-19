import { spawn } from 'node:child_process'

const STDOUT_TAIL = 64 * 1024
const STDERR_TAIL = 16 * 1024
const KILL_GRACE_MS = 3000

export type SpawnOptions = {
  command: string
  args: string[]
  cwd: string
  /** Written to the child's stdin, which is then closed. */
  stdin: string
  /** Called for every complete stdout line, across chunk boundaries. */
  onLine: (line: string) => void
  env?: NodeJS.ProcessEnv
}

export type SpawnOutcome = {
  /** `missing` when the executable does not exist (ENOENT). */
  status: 'exited' | 'missing' | 'cancelled'
  code: number | null
  stdoutTail: string
  stderrTail: string
}

export type SpawnedAgent = {
  done: Promise<SpawnOutcome>
  /** SIGTERM, then SIGKILL after a grace period. `force` kills at once — for shutdown, when nobody will be around for the grace period. */
  cancel: (options?: { force?: boolean }) => Promise<void>
}

const tail = (text: string, limit: number) => (text.length > limit ? text.slice(-limit) : text)

/**
 * The one place that launches an agent process. Executable plus argv, never a shell. The child
 * leads its own process group so cancel can stop the whole tree (agent CLIs spawn children):
 * SIGTERM first, SIGKILL after a grace period. Output is kept as bounded tails, so a chatty
 * agent cannot exhaust memory.
 */
export function spawnAgent(options: SpawnOptions): SpawnedAgent {
  let stdoutTail = ''
  let stderrTail = ''
  let pending = ''
  let cancelled = false
  let killTimer: NodeJS.Timeout | undefined

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })

  const done = new Promise<SpawnOutcome>((resolve) => {
    let settled = false
    const finish = (status: SpawnOutcome['status'], code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      if (pending !== '') options.onLine(pending)
      resolve({ status: cancelled ? 'cancelled' : status, code, stdoutTail, stderrTail })
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      stderrTail = tail(`${stderrTail}${error.message}\n`, STDERR_TAIL)
      finish(error.code === 'ENOENT' ? 'missing' : 'exited', null)
    })
    child.once('close', (code) => finish('exited', code))
  })

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutTail = tail(stdoutTail + chunk, STDOUT_TAIL)
    const lines = (pending + chunk).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') options.onLine(line)
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = tail(stderrTail + chunk, STDERR_TAIL)
  })
  child.stdin?.on('error', () => {
    // The child may exit before reading its prompt (missing CLI, bad flag); `close` reports it.
  })
  child.stdin?.end(options.stdin)

  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      // The group is already gone.
    }
  }

  return {
    done,
    cancel: async (options) => {
      if (options?.force) {
        cancelled = true
        clearTimeout(killTimer)
        signalGroup('SIGKILL')
      } else if (!cancelled) {
        cancelled = true
        signalGroup('SIGTERM')
        killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS)
      }
      await done
    },
  }
}
