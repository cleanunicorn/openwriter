import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import { herdrAttachHint } from '../../shared/jobs/herdr-hint.ts'
import { createChannel } from './channel.ts'
import { claudeConfinement } from './claude.ts'
import { parseLine } from './process-adapter.ts'
import type { AdapterHandle, AdapterOptions, AgentAdapter, Completion } from './types.ts'

export const HERDR_SESSION = 'openwrite-jobs'

/** How the adapter reaches herdr; replaced by a stub in tests. */
export type HerdrCli = {
  /** Run one herdr command and return its stdout. Rejects on a non-zero exit. */
  run: (args: string[], timeoutMs: number) => Promise<string>
  /** Start the headless server for the session, detached. */
  startServer: (args: string[]) => void
}

/**
 * openwrite may itself run inside a herdr pane, whose HERDR_* variables point at *that* session.
 * They are removed and the session is always named explicitly, so a job can never touch the
 * writer's own panes. The adapter never runs `server stop`.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key]
  return env
}

export function realHerdrCli(command: string): HerdrCli {
  return {
    run: (args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          { env: cleanEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { stderr: String(stderr) }))
            else resolve(String(stdout))
          },
        )
      }),
    startServer: (args) => {
      const child = spawn(command, args, { env: cleanEnv(), stdio: 'ignore', detached: true })
      child.on('error', () => {})
      child.unref()
    },
  }
}

/** The fields of herdr's CLI JSON replies that are read here. */
const PaneSchema = z.looseObject({
  pane_id: z.string().optional(),
  workspace_id: z.string().optional(),
})
type Pane = z.infer<typeof PaneSchema>
const ReplySchema = z.looseObject({
  result: z
    .looseObject({
      root_pane: PaneSchema.optional(),
      agent: z.looseObject({ agent_status: z.string().optional() }).optional(),
    })
    .optional(),
})
const parseReply = (stdout: string) => parseLine(ReplySchema, stdout) ?? {}
const statusOf = (stdout: string) => parseReply(stdout).result?.agent?.agent_status

/**
 * An optional backend: the job runs as an interactive `claude` inside a herdr pane, so the writer
 * can attach, watch sub-agents, and step in when the agent blocks — while the job still completes
 * through the same file contract. Evaluated in docs/herdr-evaluation.md.
 */
export function createHerdrAdapter(
  cliFor: (command: string) => HerdrCli = realHerdrCli,
): AgentAdapter {
  return {
    name: 'herdr',
    start(jobDir, options: AdapterOptions): AdapterHandle {
      const channel = createChannel<{ text: string }>()
      const session = options.config.session ?? HERDR_SESSION
      const cli = cliFor(options.config.command ?? 'herdr')
      const scoped = (...args: string[]) => ['--session', session, ...args]
      const agentName = `job-${options.jobId}`
      let pane: Pane = {}
      let cancelled = false

      const closeWorkspace = async () => {
        if (pane.workspace_id === undefined) return
        await cli.run(scoped('workspace', 'close', pane.workspace_id), 10_000).catch(() => {})
      }

      const ensureServer = async () => {
        const isServerRunning = async () =>
          (await cli.run(scoped('status', 'server'), 5000).catch(() => '')).includes(
            'status: running',
          )
        if (await isServerRunning()) return
        channel.push({ text: `starting the herdr session "${session}"` })
        cli.startServer(scoped('server'))
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          if (await isServerRunning()) return
        }
        throw new Error(`the herdr session "${session}" did not start`)
      }

      // Cancel can arrive while any setup call is in flight. After every setup step the run checks
      // the flag, so a cancelled job never goes on to start and prompt a real (paid) agent.
      const stopIfCancelled = () => {
        if (cancelled) throw new Error('cancelled')
      }

      const run = async (): Promise<Completion> => {
        try {
          await cli.run(['--version'], 5000)
        } catch {
          return {
            ok: false,
            reason: 'missing-cli',
            message:
              '"herdr" was not found on PATH. Install it or choose another agent in settings.',
          }
        }
        stopIfCancelled()
        await ensureServer()
        stopIfCancelled()
        const created = parseReply(
          await cli.run(
            scoped(
              'workspace',
              'create',
              '--cwd',
              options.workspace,
              '--label',
              agentName,
              '--no-focus',
            ),
            15_000,
          ),
        )
        pane = created.result?.root_pane ?? {}
        stopIfCancelled()
        if (pane.pane_id === undefined)
          return { ok: false, reason: 'exit', message: 'herdr did not return a pane for the job' }
        channel.push({
          text: `herdr pane ${pane.pane_id} — ${herdrAttachHint(session)}`,
        })

        const jobRel = path.relative(options.workspace, jobDir)
        const model = options.config.model ? ['--model', options.config.model] : []
        await cli.run(
          scoped(
            'agent',
            'start',
            agentName,
            '--kind',
            'claude',
            '--pane',
            pane.pane_id,
            '--timeout',
            '60000',
            '--',
            ...claudeConfinement(jobRel, options.allow),
            ...model,
            ...options.config.extraArgs,
          ),
          70_000,
        )
        stopIfCancelled()
        channel.push({ text: 'claude is ready in the pane' })

        let status = statusOf(
          await cli.run(
            scoped(
              'agent',
              'prompt',
              agentName,
              options.prompt,
              '--wait',
              '--until',
              'idle',
              '--until',
              'done',
              '--until',
              'blocked',
            ),
            24 * 3600_000,
          ),
        )
        while (status === 'blocked' && !cancelled) {
          // This is what herdr is for: the writer can attach and answer. Keep waiting meanwhile.
          channel.push({
            text: `the agent is blocked — ${herdrAttachHint(session)}`,
          })
          status = statusOf(
            await cli.run(
              scoped('agent', 'wait', agentName, '--until', 'idle', '--until', 'done'),
              24 * 3600_000,
            ),
          )
        }
        channel.push({ text: `herdr reports the agent ${status ?? 'finished'}` })
        return { ok: true }
      }

      const done = run()
        .catch((error: unknown): Completion => {
          if (cancelled) return { ok: false, reason: 'exit', message: 'cancelled' }
          const detail = error as { message?: string; stderr?: string }
          return {
            ok: false,
            reason: 'exit',
            message: `herdr: ${detail.stderr?.trim() || detail.message || 'command failed'}`.slice(
              0,
              500,
            ),
          }
        })
        .finally(async () => {
          await closeWorkspace()
          channel.close()
        })

      return {
        progress: channel.iterable,
        done,
        cancel: async () => {
          cancelled = true
          // Closing the pane stops the agent and its children (verified in the evaluation).
          if (pane.pane_id !== undefined)
            await cli.run(scoped('pane', 'close', pane.pane_id), 10_000).catch(() => {})
          await done
        },
      }
    },
  }
}
