import { describe, expect, it } from 'vitest'
import { parseHerdrAttachHint } from '../../shared/jobs/herdr-hint.ts'
import { createHerdrAdapter, type HerdrCli } from './herdr.ts'
import type { AdapterOptions } from './types.ts'

const options = (overrides: Partial<AdapterOptions> = {}): AdapterOptions => ({
  workspace: '/work/space',
  jobId: '20260919-101500-ab12',
  prompt: 'Read .zen/jobs/20260919-101500-ab12/instruction.md and follow it exactly.',
  config: { extraArgs: [] },
  allow: [],
  network: false,
  ...overrides,
})
const jobDir = '/work/space/.zen/jobs/20260919-101500-ab12'

/** A scripted herdr: records every command and answers like the real CLI's JSON. */
function stub(
  script: {
    serverRunning?: boolean
    promptStatus?: string
    hangPrompt?: boolean
    missing?: boolean
  } = {},
) {
  const calls: string[][] = []
  const started: string[][] = []
  let running = script.serverRunning ?? true
  let releasePrompt: (() => void) | undefined
  const cli: HerdrCli = {
    startServer: (args) => {
      started.push(args)
      running = true
    },
    run: async (args) => {
      calls.push(args)
      if (script.missing) throw new Error('spawn herdr ENOENT')
      const command = args
        .filter((arg, index) => !(arg === '--session' || args[index - 1] === '--session'))
        .slice(0, 2)
        .join(' ')
      if (command === 'status server')
        return running ? 'server:\n  status: running\n' : 'server:\n  status: not running\n'
      if (command === 'workspace create')
        return JSON.stringify({ result: { root_pane: { pane_id: 'w7:p1', workspace_id: 'w7' } } })
      if (command === 'agent prompt') {
        if (script.hangPrompt)
          await new Promise<void>((resolve) => {
            releasePrompt = resolve
          })
        return JSON.stringify({
          result: { agent: { agent_status: script.promptStatus ?? 'idle' } },
        })
      }
      if (command === 'agent wait')
        return JSON.stringify({ result: { agent: { agent_status: 'idle' } } })
      if (command === 'pane close') releasePrompt?.()
      return JSON.stringify({ result: { type: 'ok' } })
    },
  }
  return { cli, calls, started }
}

async function finish(handle: ReturnType<ReturnType<typeof createHerdrAdapter>['start']>) {
  const progress: string[] = []
  for await (const event of handle.progress) progress.push(event.text)
  return { completion: await handle.done, progress }
}

describe('herdr adapter', () => {
  it('runs a confined interactive claude in a pane and completes through the file contract', async () => {
    const { cli, calls, started } = stub()
    const { completion, progress } = await finish(
      createHerdrAdapter(() => cli).start(jobDir, options()),
    )
    expect(completion).toEqual({ ok: true })
    expect(started).toEqual([])
    const start = calls.find((args) => args.includes('start')) ?? []
    expect(start.slice(0, 9)).toEqual([
      '--session',
      'openwrite-jobs',
      'agent',
      'start',
      'job-20260919-101500-ab12',
      '--kind',
      'claude',
      '--pane',
      'w7:p1',
    ])
    const agentArgs = start.slice(start.indexOf('--') + 1)
    expect(agentArgs).toContain('--restricted')
    expect(agentArgs[agentArgs.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(agentArgs).toContain('Edit(.zen/jobs/20260919-101500-ab12/**)')
    expect(agentArgs.join(' ')).not.toMatch(/dangerously|bypassPermissions/)
    expect(calls.find((args) => args.includes('prompt'))).toContain(options().prompt)
    // The job's workspace in herdr is closed again; nothing is left behind.
    expect(calls.at(-1)).toEqual(['--session', 'openwrite-jobs', 'workspace', 'close', 'w7'])
    // The tray finds its "Open this job in herdr" command by parsing these very lines.
    expect(progress.map(parseHerdrAttachHint).filter(Boolean)).toEqual([
      'herdr session attach openwrite-jobs',
    ])
  })

  it('always names its own session and never stops a server', async () => {
    const { cli, calls } = stub()
    await finish(
      createHerdrAdapter(() => cli).start(
        jobDir,
        options({ config: { extraArgs: [], session: 'my-jobs' } }),
      ),
    )
    for (const args of calls.filter((call) => call[0] !== '--version'))
      expect(args.slice(0, 2)).toEqual(['--session', 'my-jobs'])
    expect(calls.some((args) => args.includes('stop'))).toBe(false)
  })

  it('starts the headless session when it is not running', async () => {
    const { cli, started } = stub({ serverRunning: false })
    const { completion, progress } = await finish(
      createHerdrAdapter(() => cli).start(jobDir, options()),
    )
    expect(completion).toEqual({ ok: true })
    expect(started).toEqual([['--session', 'openwrite-jobs', 'server']])
    expect(progress[0]).toContain('starting the herdr session')
  })

  it('keeps waiting while the agent is blocked, and tells the writer how to step in', async () => {
    const { cli, calls } = stub({ promptStatus: 'blocked' })
    const { completion, progress } = await finish(
      createHerdrAdapter(() => cli).start(jobDir, options()),
    )
    expect(completion).toEqual({ ok: true })
    expect(calls.some((args) => args.includes('wait'))).toBe(true)
    expect(progress.join('\n')).toContain('the agent is blocked — attach with')
    expect(progress.map(parseHerdrAttachHint).filter(Boolean).length).toBeGreaterThanOrEqual(2)
  })

  it('cancel closes the job’s own pane', async () => {
    const { cli, calls } = stub({ hangPrompt: true })
    const handle = createHerdrAdapter(() => cli).start(jobDir, options())
    await expect.poll(() => calls.some((args) => args.includes('prompt'))).toBe(true)
    await handle.cancel()
    expect(calls).toContainEqual(['--session', 'openwrite-jobs', 'pane', 'close', 'w7:p1'])
  })

  it('a cancel during setup never starts or prompts the agent, and closes what was created', async () => {
    const { cli, calls } = stub()
    let releaseCreate: (() => void) | undefined
    const slow: HerdrCli = {
      ...cli,
      run: async (args, timeout) => {
        if (args.includes('create'))
          await new Promise<void>((resolve) => {
            releaseCreate = resolve
          })
        return cli.run(args, timeout)
      },
    }
    const handle = createHerdrAdapter(() => slow).start(jobDir, options())
    await expect.poll(() => releaseCreate !== undefined).toBe(true)
    const cancelling = handle.cancel()
    releaseCreate?.()
    await cancelling
    expect(await handle.done).toMatchObject({ ok: false, message: 'cancelled' })
    expect(calls.some((args) => args.includes('start'))).toBe(false)
    expect(calls.some((args) => args.includes('prompt'))).toBe(false)
    expect(calls).toContainEqual(['--session', 'openwrite-jobs', 'workspace', 'close', 'w7'])
  })

  it('reports a missing herdr as missing-cli', async () => {
    const { cli } = stub({ missing: true })
    const { completion } = await finish(createHerdrAdapter(() => cli).start(jobDir, options()))
    expect(completion).toMatchObject({ ok: false, reason: 'missing-cli' })
  })
})
