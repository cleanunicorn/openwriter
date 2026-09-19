import path from 'node:path'
import type { z } from 'zod'
import type { FailureReason } from '../../shared/jobs/job-types.ts'
import { createChannel } from './channel.ts'
import { spawnAgent } from './spawn.ts'
import type { AdapterHandle, AdapterOptions, AgentAdapter, Completion } from './types.ts'

/**
 * Parse one stdout line of an agent CLI with a zod schema. Agent output is untrusted: a line that
 * is not JSON, is JSON `null`, or has the wrong shape yields undefined, never a throw. Schemas are
 * loose objects that name only the fields a reader uses, so a CLI may add fields freely.
 */
export function parseLine<T extends z.ZodType>(schema: T, line: string): z.infer<T> | undefined {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

export type CliSpec = {
  name: string
  /** Default executable; `command` in the adapter's settings replaces it. */
  command: string
  buildArgs: (jobDir: string, options: AdapterOptions) => string[]
  /** What goes to stdin; defaults to the manager's prompt. */
  buildPrompt?: (jobDir: string, options: AdapterOptions) => string
  /** One stdout line → progress text (or nothing), plus a fatal error the stream reported. */
  readLine: (line: string) => { progress?: string; error?: string }
  /** Text that means "not signed in" for this CLI, matched against stderr and stream errors. */
  authPattern: RegExp
  loginHint: string
}

/** Flags that switch a CLI's permission system off. Never part of a default command line. */
export const BYPASS_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
  '--dangerously-bypass-approvals-and-sandbox',
  'danger-full-access',
]

/** `{jobDir}`, `{jobRel}` and `{workspace}` may be used in a `baseArgs` override. */
export function substitute(args: string[], jobDir: string, workspace: string): string[] {
  const jobRel = path.relative(workspace, jobDir)
  return args.map((arg) =>
    arg
      .replaceAll('{jobDir}', jobDir)
      .replaceAll('{jobRel}', jobRel)
      .replaceAll('{workspace}', workspace),
  )
}

/**
 * Everything the claude and codex adapters share: launch through `spawnAgent`, relay progress,
 * and map the outcome to a job failure reason. The adapter itself only knows its command line
 * and how to read its output stream.
 */
export function createProcessAdapter(spec: CliSpec): AgentAdapter {
  return {
    name: spec.name,
    start(jobDir, options): AdapterHandle {
      const channel = createChannel<{ text: string }>()
      let streamError: string | undefined
      const command = options.config.command ?? spec.command
      const agent = spawnAgent({
        command,
        args: spec.buildArgs(jobDir, options),
        cwd: options.workspace,
        stdin: spec.buildPrompt?.(jobDir, options) ?? options.prompt,
        onLine: (line) => {
          // Runs inside the child's stdout handler: a bug in a reader must not become an uncaught
          // exception that takes the server down.
          let read: ReturnType<CliSpec['readLine']>
          try {
            read = spec.readLine(line)
          } catch {
            return
          }
          if (read.progress !== undefined) channel.push({ text: read.progress })
          if (read.error !== undefined) streamError = read.error
        },
      })
      const fail = (reason: FailureReason, message: string, output: string): Completion => ({
        ok: false,
        reason,
        message,
        output,
      })
      const done = agent.done
        .then((outcome): Completion => {
          const output = `${outcome.stderrTail}\n${outcome.stdoutTail}`.trim().slice(-8000)
          if (outcome.status === 'missing') {
            return fail(
              'missing-cli',
              `"${command}" was not found on PATH. Install it or set the command in settings.`,
              output,
            )
          }
          if (outcome.status === 'cancelled') return fail('exit', 'cancelled', output)
          const problem =
            streamError ??
            (outcome.code === 0 ? undefined : outcome.stderrTail.trim().split('\n').pop())
          if (problem === undefined && outcome.code === 0) return { ok: true }
          if (spec.authPattern.test(`${problem ?? ''}\n${outcome.stderrTail}`)) {
            return fail('auth', `${spec.name} is not signed in. ${spec.loginHint}`, output)
          }
          return fail(
            'exit',
            `${spec.name} exited with code ${outcome.code}: ${problem ?? 'no error output'}`,
            output,
          )
        })
        .finally(() => channel.close())
      return { progress: channel.iterable, done, cancel: agent.cancel }
    },
  }
}
