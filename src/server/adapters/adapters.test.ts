import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildClaudeArgs, readClaudeLine } from './claude.ts'
import { buildCodexArgs, codexPrompt, readCodexLine } from './codex.ts'
import { BYPASS_FLAGS, type CliSpec, createProcessAdapter, jobRelative } from './process-adapter.ts'
import { jobDir, options, workspace } from './test-helpers.ts'
import type { AdapterOptions } from './types.ts'

describe('claude command line', () => {
  it('is headless, streamed, and confined to the job directory', () => {
    const args = buildClaudeArgs(jobDir, options())
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(args).toContain('--restricted')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none')
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write')
    // The only write rule is the job directory, relative to the workspace (the cwd). claude
    // matches file writes against Edit(path) rules only, so there is no Write(path) rule.
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--safe-mode'))
    expect(allowed).toEqual(['Edit(.zen/jobs/20260919-101500-ab12/**)'])
  })

  it('applies model and extra args from settings', () => {
    const args = buildClaudeArgs(
      jobDir,
      options({ config: { model: 'sonnet', extraArgs: ['--max-budget-usd', '1'] } }),
    )
    expect(args.slice(-4)).toEqual(['--model', 'sonnet', '--max-budget-usd', '1'])
  })

  it('lets settings replace the whole base command line, with placeholders', () => {
    const args = buildClaudeArgs(
      jobDir,
      options({
        config: {
          baseArgs: ['-p', '--add-dir', '{jobDir}', '{jobRel}', '{workspace}'],
          extraArgs: [],
        },
      }),
    )
    expect(args).toEqual(['-p', '--add-dir', jobDir, '.zen/jobs/20260919-101500-ab12', workspace])
  })

  it('adds a tool only when a skill declares it', () => {
    const args = buildClaudeArgs(jobDir, options({ allow: ['Bash(asciinema *)', 'Bash(agg *)'] }))
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write,Bash')
    expect(args).toContain('Bash(asciinema *)')
  })
})

describe('codex command line', () => {
  it('makes the job directory the only writable root and reads the prompt from stdin', () => {
    const args = buildCodexArgs(jobDir, options())
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--skip-git-repo-check', '--ephemeral'])
    expect(args[args.indexOf('-C') + 1]).toBe(jobDir)
    expect(args[args.indexOf('-s') + 1]).toBe('workspace-write')
    expect(args).toContain('sandbox_workspace_write.exclude_slash_tmp=true')
    expect(args).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true')
    expect(args.at(-1)).toBe('-')
    expect(args.join(' ')).not.toContain('network_access')
  })

  it('opens the network only for a skill that asks for it, and applies the model', () => {
    const args = buildCodexArgs(
      jobDir,
      options({ network: true, config: { model: 'gpt-5', extraArgs: [] } }),
    )
    expect(args).toContain('sandbox_workspace_write.network_access=true')
    expect(args.slice(-3)).toEqual(['-m', 'gpt-5', '-'])
  })

  it('tells the agent where the workspace is, because its cwd is the job directory', () => {
    const prompt = codexPrompt(jobDir, options())
    expect(prompt).toContain(`Your working directory is the job directory: ${jobDir}`)
    expect(prompt).toContain(`The workspace root is ${workspace}`)
    expect(prompt).toContain('Read instruction.md and follow it exactly.')
  })
})

describe('no default command line bypasses permissions', () => {
  it.each([
    ['claude', buildClaudeArgs(jobDir, options())],
    [
      'claude with a skill',
      buildClaudeArgs(jobDir, options({ allow: ['Bash(agg *)'], network: true })),
    ],
    ['codex', buildCodexArgs(jobDir, options())],
    ['codex with a skill', buildCodexArgs(jobDir, options({ network: true }))],
  ])('%s', (_name, args) => {
    for (const flag of BYPASS_FLAGS) expect(args.join(' ')).not.toContain(flag)
  })
})

describe('a bypass flag cannot arrive through a skill', () => {
  it('refuses to build the command line', () => {
    expect(() =>
      buildClaudeArgs(jobDir, options({ allow: ['--dangerously-skip-permissions'] })),
    ).toThrow(/refusing/)
  })

  it('leaves the writer’s own extraArgs alone: the spec forbids a bypass default, not their choice', () => {
    const args = buildClaudeArgs(
      jobDir,
      options({ config: { extraArgs: ['--dangerously-skip-permissions'] } }),
    )
    expect(args.at(-1)).toBe('--dangerously-skip-permissions')
  })
})

describe('stream → progress', () => {
  it('reads claude stream-json lines', () => {
    expect(readClaudeLine('{"type":"system","subtype":"init","model":"claude-opus-5"}')).toEqual({
      progress: 'claude started (claude-opus-5)',
    })
    expect(
      readClaudeLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":".zen/jobs/x/article.md"}}]}}',
      ),
    ).toEqual({ progress: 'Read .zen/jobs/x/article.md' })
    expect(
      readClaudeLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Writing the  result\\nnow"}]}}',
      ),
    ).toEqual({
      progress: 'Writing the result now',
    })
    expect(
      readClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"done"}'),
    ).toEqual({
      progress: 'claude finished',
    })
    expect(
      readClaudeLine(
        '{"type":"result","subtype":"error","is_error":true,"result":"Invalid API key · Please run /login"}',
      ),
    ).toEqual({
      error: 'Invalid API key · Please run /login',
    })
  })

  it('reads codex JSONL lines', () => {
    expect(readCodexLine('{"type":"thread.started","thread_id":"t"}')).toEqual({
      progress: 'codex started',
    })
    expect(
      readCodexLine(
        '{"type":"item.completed","item":{"type":"command_execution","command":"cat instruction.md"}}',
      ),
    ).toEqual({
      progress: '$ cat instruction.md',
    })
    expect(
      readCodexLine(
        '{"type":"item.completed","item":{"type":"agent_message","text":"Wrote result.json"}}',
      ),
    ).toEqual({
      progress: 'Wrote result.json',
    })
    expect(readCodexLine('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')).toEqual({
      error: '401 Unauthorized',
    })
  })

  it.each([
    'null',
    '42',
    '"text"',
    '[]',
    '{"type":"assistant","message":{"content":123}}',
    '{"type":"assistant","message":{"content":[null]}}',
    '{"type":"assistant","message":null}',
    '{"type":"item.completed","item":"not an object"}',
    '{"type":"result","is_error":"yes"}',
  ])('treats valid JSON of the wrong shape as an uninteresting line: %s', (line) => {
    expect(readClaudeLine(line)).toEqual({})
    expect(readCodexLine(line)).toEqual({})
  })

  it('a reader that throws anyway cannot crash the run', async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'openwrite-reader-'))
    const handle = createProcessAdapter({
      name: 'echo',
      command: process.execPath,
      buildArgs: () => [path.join(import.meta.dirname, 'fixtures', 'echo-agent.ts'), 'ok'],
      readLine: () => {
        throw new Error('reader bug')
      },
      authPattern: /never/,
      loginHint: '',
    }).start(temp, options({ workspace: temp }))
    expect(await handle.done).toEqual({ ok: true })
    rmSync(temp, { recursive: true, force: true })
  })

  it('ignores lines that are not JSON or not interesting', () => {
    expect(readClaudeLine('not json')).toEqual({})
    expect(readCodexLine('{"type":"item.started","item":{"type":"reasoning"}}')).toEqual({})
  })
})

describe('process adapter: failures become reasons', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'openwrite-adapter-'))
  afterAll(() => rmSync(temp, { recursive: true, force: true }))
  const fixture = path.join(import.meta.dirname, 'fixtures', 'echo-agent.ts')
  const spec = (mode: string, command = process.execPath): CliSpec => ({
    name: 'echo',
    command,
    buildArgs: () => [fixture, mode],
    readLine: (line) => ({ progress: line }),
    authPattern: /something went wrong/,
    loginHint: 'Sign in.',
  })
  const run = async (cli: CliSpec, config: AdapterOptions['config'] = { extraArgs: [] }) => {
    const handle = createProcessAdapter(cli).start(temp, options({ workspace: temp, config }))
    const progress: string[] = []
    for await (const event of handle.progress) progress.push(event.text)
    return { completion: await handle.done, progress }
  }

  it('completes and relays progress', async () => {
    const { completion, progress } = await run(spec('ok'))
    expect(completion).toEqual({ ok: true })
    expect(progress).toHaveLength(3)
  })

  it('maps a missing executable to missing-cli and honours the command override', async () => {
    const { completion } = await run(spec('ok'), {
      command: 'openwrite-no-such-cli',
      extraArgs: [],
    })
    expect(completion).toMatchObject({ ok: false, reason: 'missing-cli' })
    expect(completion.ok === false && completion.message).toContain('openwrite-no-such-cli')
  })

  it('maps an auth-looking failure to auth, with the login hint', async () => {
    const { completion } = await run(spec('exit'))
    expect(completion).toMatchObject({ ok: false, reason: 'auth' })
    expect(completion.ok === false && completion.message).toContain('Sign in.')
  })

  it('maps any other non-zero exit to exit, keeping the output', async () => {
    const { completion } = await run({ ...spec('exit'), authPattern: /never matches/ })
    expect(completion).toMatchObject({ ok: false, reason: 'exit' })
    expect(completion.ok === false && completion.output).toContain('something went wrong')
  })

  it('says so when a failing agent wrote nothing to stderr', async () => {
    const { completion } = await run({ ...spec('silent-exit'), authPattern: /never matches/ })
    expect(completion).toMatchObject({ ok: false, reason: 'exit' })
    expect(completion.ok === false && completion.message).toBe(
      'echo exited with code 2: no error output',
    )
  })

  it('cancel ends the run', async () => {
    const handle = createProcessAdapter(spec('hang')).start(temp, options({ workspace: temp }))
    await handle.cancel()
    expect(await handle.done).toMatchObject({ ok: false, message: 'cancelled' })
  })
})

describe('jobRelative', () => {
  it('names the job directory with forward slashes, as the permission globs need, on Windows too', () => {
    expect(jobRelative('/work/space', '/work/space/.zen/jobs/j1', path.posix)).toBe('.zen/jobs/j1')
    expect(jobRelative('C:\\work\\space', 'C:\\work\\space\\.zen\\jobs\\j1', path.win32)).toBe(
      '.zen/jobs/j1',
    )
  })
})
