import path from 'node:path'
import { z } from 'zod'
import {
  type CliSpec,
  type LineRead,
  assertNoBypass,
  clipProgress,
  createProcessAdapter,
  parseLine,
  substitute,
} from './process-adapter.ts'
import type { AdapterOptions } from './types.ts'

/** Built-in tools plus whatever a skill's `allow:` rules name (`Bash(asciinema *)` → `Bash`). */
function toolsFor(allow: string[]): string[] {
  const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write']
  for (const rule of allow) {
    const tool = rule.split('(')[0]?.trim()
    if (tool && !tools.includes(tool)) tools.push(tool)
  }
  return tools
}

/**
 * The permission part of the command line, shared by print mode and by an interactive claude
 * inside herdr. It is an allow list, not a bypass: `dontAsk` denies whatever the list does not
 * cover, `--restricted` ignores user/project settings (a broad allow rule there would defeat the
 * list) and confines the file tools to the working directory, and the only write rule is the job
 * directory. `Edit(path)` rules cover every file-editing tool; claude ignores `Write(path)`.
 */
export function claudeConfinement(jobRel: string, allow: string[]): string[] {
  return [
    '--permission-mode',
    'dontAsk',
    '--restricted',
    '--tools',
    toolsFor(allow).join(','),
    '--allowedTools',
    `Edit(${jobRel}/**)`,
    ...allow,
    '--safe-mode',
  ]
}

/**
 * `claude` in headless print mode with streamed JSON. Flags verified against
 * `claude --help` 2.1.278 — see DECISIONS.md, "Real agents".
 */
export function buildClaudeArgs(jobDir: string, options: AdapterOptions): string[] {
  const jobRel = path.relative(options.workspace, jobDir)
  const base = options.config.baseArgs
    ? substitute(options.config.baseArgs, jobDir, options.workspace)
    : [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        // With --print nobody can answer a prompt: anything that would ask is denied.
        '--permission-prompts',
        'none',
        ...claudeConfinement(jobRel, options.allow),
        '--no-session-persistence',
      ]
  // What openwrite builds by itself (defaults + a skill's allowances) never bypasses permissions.
  // The writer's own baseArgs/extraArgs are theirs to set and are not checked here.
  if (options.config.baseArgs === undefined) assertNoBypass(base)
  const model = options.config.model ? ['--model', options.config.model] : []
  return [...base, ...model, ...options.config.extraArgs]
}

/** The fields of claude's stream-json events that are read here. */
const StreamLineSchema = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  model: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  message: z
    .looseObject({
      content: z
        .array(
          z.looseObject({
            type: z.string().optional(),
            text: z.string().optional(),
            name: z.string().optional(),
            input: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
})

export function readClaudeLine(line: string): LineRead {
  const event = parseLine(StreamLineSchema, line)
  if (event === undefined) return {}
  if (event.type === 'system' && event.subtype === 'init')
    return { progress: `claude started (${event.model ?? 'default model'})` }
  if (event.type === 'assistant') {
    for (const part of event.message?.content ?? []) {
      if (part.type === 'tool_use') {
        const input = part.input ?? {}
        const detail = input.file_path ?? input.path ?? input.pattern ?? input.command ?? ''
        return { progress: clipProgress(`${part.name ?? 'tool'} ${String(detail)}`) }
      }
      if (part.type === 'text' && part.text?.trim()) return { progress: clipProgress(part.text) }
    }
    return {}
  }
  if (event.type === 'result') {
    return event.is_error
      ? { error: clipProgress(event.result ?? event.subtype ?? 'error') }
      : { progress: 'claude finished' }
  }
  return {}
}

export const claudeSpec: CliSpec = {
  name: 'claude',
  command: 'claude',
  buildArgs: buildClaudeArgs,
  readLine: readClaudeLine,
  authPattern:
    /invalid api key|please run \/login|not logged in|authentication|unauthorized|oauth token/i,
  loginHint: 'Run `claude` once in a terminal and sign in.',
}

export const createClaudeAdapter = () => createProcessAdapter(claudeSpec)
