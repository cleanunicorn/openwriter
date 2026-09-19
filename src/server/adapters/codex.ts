import path from 'node:path'
import { z } from 'zod'
import {
  type CliSpec,
  type LineRead,
  clipProgress,
  createProcessAdapter,
  parseLine,
  substitute,
} from './process-adapter.ts'
import type { AdapterOptions } from './types.ts'

/**
 * `codex exec` with JSONL output. Flags verified against `codex exec --help` 0.155.1 — see
 * DECISIONS.md, "Real agents", for the sandbox rows that were tried and which one ships.
 */
export function buildCodexArgs(jobDir: string, options: AdapterOptions): string[] {
  const base = options.config.baseArgs
    ? substitute(options.config.baseArgs, jobDir, options.workspace)
    : [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        // No `-o <jobDir>/last-message.txt`: the codex CLI writes that file outside its own sandbox,
        // at a name the agent controls — a symlink there would be an outside write.
        // The job directory is the only writable root. `-s read-only --add-dir <jobDir>` does not
        // work: --add-dir only extends workspace-write. /tmp and $TMPDIR are excluded as well.
        '-C',
        jobDir,
        '-s',
        'workspace-write',
        '-c',
        'sandbox_workspace_write.exclude_slash_tmp=true',
        '-c',
        'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      ]
  // codex has no per-command allow list; a skill that needs the network says so explicitly.
  const network = options.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []
  const model = options.config.model ? ['-m', options.config.model] : []
  return [...base, ...network, ...model, ...options.config.extraArgs, '-']
}

/**
 * codex runs with the job directory as its working root (a recorded deviation from "workspace as
 * working directory" — DECISIONS.md, "Real agents" → codex: it is what makes the job directory
 * the only writable place).
 * The prompt therefore says where the workspace is and how the paths in instruction.md map.
 */
export function codexPrompt(jobDir: string, options: AdapterOptions): string {
  const jobRel = path.relative(options.workspace, jobDir)
  return [
    `Your working directory is the job directory: ${jobDir}`,
    `The workspace root is ${options.workspace}. You may read it (for example sources/), but you can only write in your working directory.`,
    `Paths that start with ${jobRel}/ in the instructions are files in your working directory.`,
    options.prompt.replaceAll(`${jobRel}/`, ''),
  ].join('\n')
}

/** The fields of `codex exec --json` events that are read here. */
const CodexLineSchema = z.looseObject({
  type: z.string().optional(),
  message: z.string().optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
  item: z
    .looseObject({
      type: z.string().optional(),
      text: z.string().optional(),
      command: z.string().optional(),
      path: z.string().optional(),
    })
    .optional(),
})

export function readCodexLine(line: string): LineRead {
  const event = parseLine(CodexLineSchema, line)
  if (event === undefined) return {}
  if (event.type === 'thread.started') return { progress: 'codex started' }
  if (event.type === 'error' || event.type === 'turn.failed') {
    return {
      error: clipProgress(event.error?.message ?? event.message ?? 'codex reported an error'),
    }
  }
  if (event.type === 'turn.completed') return { progress: 'codex finished' }
  const item = event.item
  if (item === undefined || event.type !== 'item.completed') return {}
  if (item.command) return { progress: clipProgress(`$ ${item.command}`) }
  if (item.text?.trim()) return { progress: clipProgress(item.text) }
  if (item.path) return { progress: clipProgress(`${item.type ?? 'file'} ${item.path}`) }
  return {}
}

export const codexSpec: CliSpec = {
  name: 'codex',
  command: 'codex',
  buildArgs: buildCodexArgs,
  buildPrompt: codexPrompt,
  readLine: readCodexLine,
  authPattern: /not logged in|401|unauthorized|api key|login required|codex login/i,
  loginHint: 'Run `codex login` in a terminal.',
}

export const createCodexAdapter = () => createProcessAdapter(codexSpec)
