import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDoc, createIdMinter } from '../../shared/blocks/index.ts'
import type { ServerEvent } from '../../shared/events.ts'
import type { Job, JobRequest } from '../../shared/jobs/job-types.ts'
import { createFakeAdapter, FakeGate } from '../adapters/fake.ts'
import { createProcessAdapter } from '../adapters/process-adapter.ts'
import { AdapterRegistry } from '../adapters/registry.ts'
import { alive } from '../adapters/test-helpers.ts'
import type { AdapterHandle, AgentAdapter, Completion, ProgressEvent } from '../adapters/types.ts'
import { createApp } from '../app.ts'
import { createTestApp, json, type TestApp } from '../test-helpers.ts'
import { JobManager } from './manager.ts'

let t: TestApp
beforeEach(() => {
  t = createTestApp({ fakeControl: true })
})
afterEach(() => t.cleanup())

const articlePath = () => path.join(t.workspace, 'content', 'posts', 'hello-openwrite', 'index.md')
const jobDir = (id: string) => path.join(t.workspace, '.zen', 'jobs', id)

function request(
  instruction: string,
  pick: (raws: string[]) => number[],
  extra: Partial<JobRequest> = {},
): JobRequest {
  const doc = createDoc(readFileSync(articlePath(), 'utf8'), createIdMinter())
  const indices = pick(doc.blocks.map((block) => block.raw))
  return {
    doc: { kind: 'article', slug: 'hello-openwrite' },
    scope: 'blocks',
    instruction,
    targets: indices.map((index) => doc.blocks[index]?.id ?? 'b999'),
    snapshot: doc,
    ...extra,
  }
}
const byText = (text: string) => (raws: string[]) => [raws.findIndex((raw) => raw.includes(text))]

async function start(body: JobRequest): Promise<Job> {
  const res = await t.send('POST', '/api/jobs', body)
  expect(res.status).toBe(201)
  return json(res)
}
const state = (id: string) => t.jobs.get(id).state
const until = (id: string, wanted: Job['state']) =>
  expect.poll(() => state(id), { timeout: 5000 }).toBe(wanted)
const atCheckpoint = (id: string) =>
  expect.poll(() => t.gate.waitingIds(), { timeout: 5000 }).toContain(id)
/** Let a fake job past its checkpoint and wait for its proposal. */
const runToReady = async (id: string): Promise<Job> => {
  await atCheckpoint(id)
  t.gate.release(id)
  await until(id, 'ready')
  return t.jobs.get(id)
}

describe('the job file contract', () => {
  it('runs a job whose snapshot holds a block that exists only in the open editor', async () => {
    // The client names such a block `live<n>` (doc-reducer `liveDoc`): the store never mints
    // that, so an op aimed at it cannot land on another block. The contract must carry it end to
    // end — snapshot, targets, article.md markers, the agent's result.
    const base = request('Make it louder', byText('## Why blocks'))
    const live = { id: 'live1', raw: 'Typed but not committed yet', kind: 'content' as const }
    const job = await start({
      ...base,
      targets: ['live1'],
      snapshot: {
        blocks: [...base.snapshot.blocks, live],
        gaps: [...base.snapshot.gaps.slice(0, -1), '\n\n', '\n'],
      },
    })
    expect(readFileSync(path.join(jobDir(job.id), 'article.md'), 'utf8')).toContain(
      '<!-- zen:block id=live1 target -->\nTyped but not committed yet\n<!-- /zen:block -->',
    )
    const ready = await runToReady(job.id)
    expect(ready.result?.ops).toEqual([
      { op: 'replace', block_id: 'live1', markdown: 'TYPED BUT NOT COMMITTED YET' },
    ])
  })

  it('writes the contract files and leaves the article untouched', async () => {
    const before = readFileSync(articlePath())
    const job = await start(request('Make it louder', byText('## Why blocks')))
    const dir = jobDir(job.id)
    expect(readdirSync(dir).sort()).toEqual(
      [
        'article.md',
        'assets',
        'brief.md',
        'instruction.md',
        'job.json',
        'progress.log',
        'strategy.md',
        'targets.json',
      ].filter((name) => name !== 'progress.log' || existsSync(path.join(dir, name))),
    )
    const instruction = readFileSync(path.join(dir, 'instruction.md'), 'utf8')
    expect(instruction).toContain('Make it louder')
    expect(instruction).toContain('Scope `blocks`')
    expect(instruction).toContain('strategy.md')
    // Adapter-neutral: codex runs from the job directory, so the contract must not claim a cwd.
    expect(instruction).not.toMatch(/working directory is/i)
    expect(instruction).toContain('relative to the workspace root')
    const article = readFileSync(path.join(dir, 'article.md'), 'utf8')
    expect(article).toContain(
      `<!-- zen:block id=${job.targets[0]} target -->\n## Why blocks\n<!-- /zen:block -->`,
    )
    expect(JSON.parse(readFileSync(path.join(dir, 'targets.json'), 'utf8'))).toMatchObject({
      scope: 'blocks',
      blockIds: job.targets,
    })
    expect(readFileSync(path.join(dir, 'strategy.md'), 'utf8')).toContain('# Writing strategy')
    expect(readFileSync(path.join(dir, 'brief.md'), 'utf8')).toContain('Brief: Hello, openwrite')
    // Markers exist only in the snapshot, never in the article.
    expect(readFileSync(articlePath()).equals(before)).toBe(true)
    expect(readFileSync(articlePath(), 'utf8')).not.toContain('zen:block')
  })

  it('carries the earlier turns of a conversation as a bounded conversation.md', async () => {
    const turn = {
      scope: 'article' as const,
      skill: null,
      summary: 'Rewrote the intro.',
      notes: null,
      outcome: 'rejected' as const,
    }
    const job = await start(
      request('Make it shorter', byText('## Why blocks'), {
        conversation: [
          { ...turn, instruction: 'rewrite the intro' },
          { ...turn, instruction: 'now the ending', outcome: 'accepted' },
        ],
      }),
    )
    const dir = jobDir(job.id)
    const conversation = readFileSync(path.join(dir, 'conversation.md'), 'utf8')
    expect(conversation.indexOf('rewrite the intro')).toBeLessThan(
      conversation.indexOf('now the ending'),
    )
    expect(conversation).toContain('— rejected')
    expect(conversation).toContain('The result: Rewrote the intro.')
    const instruction = readFileSync(path.join(dir, 'instruction.md'), 'utf8')
    expect(instruction).toContain(`.zen/jobs/${job.id}/conversation.md`)
  })

  it('re-bounds an oversized conversation instead of writing it all', async () => {
    const huge = 'z'.repeat(20000)
    const job = await start(
      request('Make it shorter', byText('## Why blocks'), {
        conversation: Array.from({ length: 20 }, () => ({
          instruction: huge,
          scope: 'research' as const,
          skill: null,
          summary: huge,
          notes: huge,
          outcome: 'answered' as const,
        })),
      }),
    )
    const conversation = readFileSync(path.join(jobDir(job.id), 'conversation.md'), 'utf8')
    expect(conversation.length).toBeLessThanOrEqual(8000)
  })

  it('gives a first turn exactly the files and instruction it always had', async () => {
    const first = await start(request('Make it louder', byText('## Why blocks')))
    const empty = await start(
      request('Make it louder', byText('This is a sample'), { conversation: [] }),
    )
    for (const job of [first, empty]) {
      expect(existsSync(path.join(jobDir(job.id), 'conversation.md'))).toBe(false)
      const instruction = readFileSync(path.join(jobDir(job.id), 'instruction.md'), 'utf8')
      expect(instruction).not.toContain('conversation.md')
    }
    // Same request but for the job id and targets: the same bytes, the conversation field aside.
    const text = (job: Job) =>
      readFileSync(path.join(jobDir(job.id), 'instruction.md'), 'utf8').replaceAll(job.id, 'ID')
    expect(text(empty)).toBe(text(first))
  })

  it('gives an empty document the virtual b0 anchor', async () => {
    const job = await start({
      doc: { kind: 'brief', slug: 'hello-openwrite' },
      scope: 'article',
      instruction: 'fake:draft',
      targets: ['b0'],
      snapshot: { blocks: [], gaps: [''] },
    })
    expect(readFileSync(path.join(jobDir(job.id), 'article.md'), 'utf8')).toContain(
      '<!-- zen:block id=b0 target -->',
    )
    await runToReady(job.id)
    expect(t.jobs.get(job.id).result?.ops[0]).toMatchObject({ op: 'insert_after', block_id: 'b0' })
  })

  it('a job whose files cannot be written is not created at all', async () => {
    // strategy.md that is not UTF-8: reading the context for the job throws.
    writeFileSync(path.join(t.workspace, 'strategy.md'), Buffer.from([0x23, 0xff, 0xfe, 0x0a]))
    const res = await t.send('POST', '/api/jobs', request('x', byText('## Why blocks')))
    expect(res.status).toBe(422)
    expect(t.jobs.list()).toEqual([])
    expect(
      existsSync(path.join(t.workspace, '.zen', 'jobs'))
        ? readdirSync(path.join(t.workspace, '.zen', 'jobs'))
        : [],
    ).toEqual([])
    // The next job is unaffected.
    writeFileSync(path.join(t.workspace, 'strategy.md'), '# Strategy\n')
    expect(
      (await t.send('POST', '/api/jobs', request('fake:upper', byText('## Why blocks')))).status,
    ).toBe(201)
  })

  it('rejects a request whose targets are not in the snapshot', async () => {
    const body = request('x', byText('## Why blocks'))
    const res = await t.send('POST', '/api/jobs', { ...body, targets: ['b999'] })
    expect(res.status).toBe(400)
  })
})

describe('lifecycle', () => {
  it('runs, streams progress, validates, and waits for review', async () => {
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    const job = await start(request('fake:upper', byText('## Why blocks')))
    await atCheckpoint(job.id)
    expect(state(job.id)).toBe('running')
    t.gate.release(job.id)
    await until(job.id, 'ready')

    const done = t.jobs.get(job.id)
    expect(done.result?.ops).toEqual([
      { op: 'replace', block_id: job.targets[0], markdown: '## WHY BLOCKS' },
    ])
    expect(done.progress.join('\n')).toContain('writing result.json')
    expect(
      seen
        .filter((e) => e.type === 'job.state')
        .map((e) => (e.type === 'job.state' ? e.job.state : '')),
    ).toEqual(['queued', 'running', 'validating', 'ready'])
    expect(seen.some((event) => event.type === 'job.progress')).toBe(true)
    expect(readFileSync(path.join(jobDir(job.id), 'progress.log'), 'utf8')).toContain('fake agent')
  })

  it('repairs a malformed result once and keeps the rejected output', async () => {
    const job = await start(request('fake:invalid-once', byText('## Why blocks')))
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'repairing')
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
    expect(readFileSync(path.join(jobDir(job.id), 'result.invalid.json'), 'utf8')).toContain(
      'not quite json',
    )
    expect(readFileSync(path.join(jobDir(job.id), 'repair.md'), 'utf8')).toContain('not valid JSON')
  })

  it('fails with the raw output after one repair attempt', async () => {
    const job = await start(request('fake:invalid-twice', byText('## Why blocks')))
    for (const _attempt of [1, 2]) {
      await atCheckpoint(job.id)
      t.gate.release(job.id)
      await expect.poll(() => t.gate.waitingIds()).not.toContain(job.id)
    }
    await until(job.id, 'failed')
    const failed = t.jobs.get(job.id)
    expect(failed.reason).toBe('invalid-result')
    expect(failed.rawOutput).toContain('not quite json')
  })

  it('rejects a well-formed result that reaches outside its targets', async () => {
    const job = await start(request('fake:out-of-scope', byText('## Why blocks')))
    for (const _attempt of [1, 2]) {
      await atCheckpoint(job.id)
      t.gate.release(job.id)
      await expect.poll(() => t.gate.waitingIds()).not.toContain(job.id)
    }
    await until(job.id, 'failed')
    expect(t.jobs.get(job.id).error).toContain('outside the target blocks')
  })

  it.each([
    ['fake:fail', 'exit'],
    ['fake:auth', 'auth'],
  ])('%s becomes a failed job with reason %s', async (instruction, reason) => {
    const job = await start(request(instruction, byText('## Why blocks')))
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'failed')
    expect(t.jobs.get(job.id).reason).toBe(reason)
  })

  it('stops an agent that exceeds the timeout', async () => {
    const config = path.join(t.workspace, '.zen', 'config.json')
    writeFileSync(config, JSON.stringify({ mainAgent: 'fake', jobTimeoutSec: 1 }))
    const job = await start(request('fake:hang', byText('## Why blocks')))
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'failed')
    expect(t.jobs.get(job.id).reason).toBe('timeout')
  })

  it('cancels a running job, and leaves a finished proposal reviewable', async () => {
    const running = await start(request('fake:upper', byText('## Why blocks')))
    await atCheckpoint(running.id)
    expect((await json(t.send('POST', `/api/jobs/${running.id}/cancel`))).state).toBe('cancelled')
    expect(state(running.id)).toBe('cancelled')

    const finished = await start(request('fake:upper', byText('## A table')))
    await runToReady(finished.id)
    expect((await json(t.send('POST', `/api/jobs/${finished.id}/cancel`))).state).toBe('ready')
  })

  it('respects the concurrency limit with a FIFO queue', async () => {
    writeFileSync(
      path.join(t.workspace, '.zen', 'config.json'),
      JSON.stringify({ mainAgent: 'fake', concurrency: 1 }),
    )
    const first = await start(request('fake:upper', byText('## Why blocks')))
    const second = await start(request('fake:upper', byText('## A table')))
    await atCheckpoint(first.id)
    expect(state(second.id)).toBe('queued')
    t.gate.release(first.id)
    await until(first.id, 'ready')
    // Waiting for review holds no process slot.
    await atCheckpoint(second.id)
    expect(state(second.id)).toBe('running')
  })

  it('fails at once for an unknown agent', async () => {
    const other = createTestApp({ adapterOverride: 'nonesuch' })
    try {
      const res = await other.send('POST', '/api/jobs', {
        ...request('x', byText('## Why blocks')),
      })
      const job = await json(res)
      expect(job.state).toBe('failed')
      expect(job.reason).toBe('missing-cli')
    } finally {
      other.cleanup()
    }
  })
})

describe('nothing inside a job run can take the server down', () => {
  const adapterThat = (behaviour: (jobDir: string) => AdapterHandle): AgentAdapter => ({
    name: 'fake',
    start: (dir) => behaviour(dir),
  })
  const handle = (
    done: Promise<Completion>,
    progress: AsyncIterable<ProgressEvent> = (async function* () {})(),
  ) => ({
    progress,
    done,
    cancel: async () => {},
  })
  const runWith = async (adapter: AgentAdapter) => {
    const manager = new JobManager({
      workspace: t.context.workspace,
      events: t.context.events,
      registry: new AdapterRegistry().register(adapter),
    })
    const job = manager.create(request('x', byText('## Why blocks')))
    await expect.poll(() => manager.get(job.id).state, { timeout: 5000 }).toBe('failed')
    return manager.get(job.id)
  }

  it('an agent that leaves a directory named result.json', async () => {
    const failed = await runWith(
      adapterThat((dir) => {
        mkdirSync(path.join(dir, 'result.json'), { recursive: true })
        return handle(Promise.resolve({ ok: true }))
      }),
    )
    expect(failed.reason).toBe('invalid-result')
    expect(failed.error).toContain('not a plain file')
  })

  it('an adapter whose start throws', async () => {
    const failed = await runWith(
      adapterThat(() => {
        throw new Error('spawn exploded')
      }),
    )
    expect(failed).toMatchObject({ reason: 'exit' })
    expect(failed.error).toContain('spawn exploded')
  })

  it('an adapter whose completion rejects', async () => {
    const failed = await runWith(
      adapterThat(() => handle(Promise.reject(new Error('completion rejected')))),
    )
    expect(failed.error).toContain('completion rejected')
  })

  it('an adapter whose progress stream throws', async () => {
    const broken = (async function* () {
      yield { text: 'one' }
      throw new Error('progress broke')
    })()
    const failed = await runWith(adapterThat(() => handle(new Promise(() => {}), broken)))
    expect(failed.error).toContain('progress broke')
  })

  it('a job directory that can no longer be written', async () => {
    const failed = await runWith(
      adapterThat((dir) => {
        rmSync(dir, { recursive: true, force: true })
        writeFileSync(dir, 'now a file')
        return handle(Promise.resolve({ ok: true }))
      }),
    )
    expect(failed.state).toBe('failed')
  })

  it('an unreadable job directory does not stop the next server start', () => {
    mkdirSync(path.join(t.workspace, '.zen', 'jobs', '20260101-000000-dead', 'job.json'), {
      recursive: true,
    })
    const restarted = createApp({
      workspace: t.workspace,
      workspacesFile: t.workspacesFile,
      workspacesDir: t.workspacesDir,
      fakeControl: false,
      allowedHosts: () => [],
    })
    expect(restarted.jobs.list()).toEqual([])
    void restarted.dispose()
  })
})

describe('shutdown', () => {
  it('kills an agent that ignores SIGTERM before the server exits', async () => {
    const pidFile = path.join(t.workspace, 'stubborn.pid')
    const stubborn = createProcessAdapter({
      name: 'fake',
      command: process.execPath,
      buildArgs: () => [
        path.join(import.meta.dirname, '..', 'adapters', 'fixtures', 'echo-agent.ts'),
        'stubborn',
        pidFile,
      ],
      readLine: () => ({}),
      authPattern: /never/,
      loginHint: '',
    })
    const manager = new JobManager({
      workspace: t.context.workspace,
      events: t.context.events,
      registry: new AdapterRegistry().register(stubborn),
    })
    manager.create(request('x', byText('## Why blocks')))
    await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(pid)).toBe(true)
    const started = Date.now()
    await manager.shutdown()
    // No three-second grace period on shutdown: nobody would be left to send the SIGKILL.
    expect(Date.now() - started).toBeLessThan(1500)
    await expect.poll(() => alive(pid), { timeout: 2000 }).toBe(false)
  })
})

describe('agent selection', () => {
  it('switching the main agent is a settings change: the next job uses it', async () => {
    const plain = createTestApp({ adapterOverride: undefined })
    const config = path.join(plain.workspace, '.zen', 'config.json')
    const missing = { command: 'openwrite-no-such-cli' }
    try {
      for (const agent of ['claude', 'codex']) {
        writeFileSync(
          config,
          JSON.stringify({ mainAgent: agent, adapters: { claude: missing, codex: missing } }),
        )
        const job = await json(
          plain.send('POST', '/api/jobs', { ...request('x', byText('## Why blocks')) }),
        )
        expect(job.adapter).toBe(agent)
        await expect.poll(() => plain.jobs.get(job.id).state, { timeout: 5000 }).toBe('failed')
        // The command override from settings was used, and a missing CLI is a clear job state.
        expect(plain.jobs.get(job.id)).toMatchObject({ reason: 'missing-cli' })
        expect(plain.jobs.get(job.id).error).toContain('openwrite-no-such-cli')
      }
    } finally {
      plain.cleanup()
    }
  })
})

describe('review decisions', () => {
  async function readyJob(instruction: string, text = 'Results arrive'): Promise<Job> {
    const job = await start(request(instruction, byText(text)))
    return runToReady(job.id)
  }
  const bundle = () => path.dirname(articlePath())

  it('copies only the assets of accepted ops into the bundle and returns the path map', async () => {
    const job = await readyJob('fake:asset')
    const body = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [0], rejected: [] }),
    )
    expect(body.assetMap).toEqual({ 'assets/fake-diagram.png': 'fake-diagram.png' })
    expect(existsSync(path.join(bundle(), 'fake-diagram.png'))).toBe(true)
    expect(body.job.state).toBe('settled')
    // Copied, not moved: the job directory keeps its output.
    expect(existsSync(path.join(jobDir(job.id), 'assets', 'fake-diagram.png'))).toBe(true)
  })

  it('never overwrites an existing file in the bundle', async () => {
    writeFileSync(path.join(bundle(), 'fake-diagram.png'), 'the writer’s own file')
    const job = await readyJob('fake:asset')
    const body = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [0], rejected: [] }),
    )
    expect(body.assetMap).toEqual({ 'assets/fake-diagram.png': 'fake-diagram-2.png' })
    expect(readFileSync(path.join(bundle(), 'fake-diagram.png'), 'utf8')).toBe(
      'the writer’s own file',
    )
  })

  it('a rejected op leaves no asset behind', async () => {
    const job = await readyJob('fake:asset')
    const body = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [], rejected: [0] }),
    )
    expect(body.assetMap).toEqual({})
    expect(body.job.state).toBe('settled')
    expect(existsSync(path.join(bundle(), 'fake-diagram.png'))).toBe(false)
  })

  it('stays ready until every op is decided', async () => {
    const job = await readyJob('fake:multi')
    const partial = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [0], rejected: [] }),
    )
    expect(partial.job.state).toBe('ready')
    const rest = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [1], rejected: [2] }),
    )
    expect(rest.job.state).toBe('settled')
    expect(rest.job.decisions).toEqual({ '0': 'accepted', '1': 'accepted', '2': 'rejected' })
  })

  it('takes back an acceptance the client could not apply, and only that', async () => {
    const job = await readyJob('fake:multi')
    const settled = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [0, 1], rejected: [2] }),
    )
    expect(settled.job.state).toBe('settled')

    // Op 1's block was gone when the client came to apply it; op 2 was rejected, not accepted.
    const res = await t.send('POST', `/api/jobs/${job.id}/decisions/withdraw`, { indices: [1, 2] })
    expect(res.status).toBe(200)
    const back = await json(res)
    expect(back.state).toBe('ready')
    expect(back.decisions).toEqual({ '0': 'accepted', '2': 'rejected' })
    expect(back.revision).toBeGreaterThan(settled.job.revision)
    // Reviewable again: the client can now report it stale, which a settled job ignores.
    const stale = await json(t.send('POST', `/api/jobs/${job.id}/stale`, { reason: 'gone' }))
    expect(stale.state).toBe('stale')
  })

  it('withdrawing nothing that was accepted changes nothing, and a job that is not under review refuses', async () => {
    const job = await readyJob('fake:multi')
    await t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [], rejected: [0] })
    const before = t.jobs.get(job.id)
    const same = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions/withdraw`, { indices: [0, 1, 99] }),
    )
    expect(same.decisions).toEqual({ '0': 'rejected' })
    expect(same.revision).toBe(before.revision)
    expect(
      (await t.send('POST', `/api/jobs/${job.id}/decisions/withdraw`, { indices: [] })).status,
    ).toBe(400)

    await t.send('POST', `/api/jobs/${job.id}/stale`, { reason: 'gone' })
    expect(
      (await t.send('POST', `/api/jobs/${job.id}/decisions/withdraw`, { indices: [1] })).status,
    ).toBe(409)
  })

  it('decides an op once: a repeated accept changes nothing, and accept+reject of one op is refused', async () => {
    const job = await readyJob('fake:multi')
    const first = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [1], rejected: [] }),
    )
    expect(first.job.decisions).toEqual({ '1': 'accepted' })
    // The same op again, this time as a reject: ignored, the first decision stands.
    const again = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [], rejected: [1] }),
    )
    expect(again.job.decisions).toEqual({ '1': 'accepted' })
    expect(again.job.state).toBe('ready')
    const both = await t.send('POST', `/api/jobs/${job.id}/decisions`, {
      accepted: [0],
      rejected: [0],
    })
    expect(both.status).toBe(400)
  })

  it('refuses decisions on a job that is not ready, and unknown op indices', async () => {
    const job = await start(request('fake:upper', byText('## Why blocks')))
    expect(
      (await t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [0], rejected: [] }))
        .status,
    ).toBe(409)
    const ready = await readyJob('fake:upper')
    expect(
      (await t.send('POST', `/api/jobs/${ready.id}/decisions`, { accepted: [7], rejected: [] }))
        .status,
    ).toBe(400)
  })

  it('a research job has no ops and settles with an empty decision', async () => {
    const job = await start(request('fake:research', () => [], { scope: 'research', targets: [] }))
    await runToReady(job.id)
    expect(t.jobs.get(job.id).result?.notes).toContain('Findings')
    const body = await json(
      t.send('POST', `/api/jobs/${job.id}/decisions`, { accepted: [], rejected: [] }),
    )
    expect(body.job.state).toBe('settled')
  })
})

describe('staleness and restart', () => {
  it('the client can mark a job stale; its output stays readable', async () => {
    const job = await start(request('fake:upper', byText('## Why blocks')))
    await runToReady(job.id)
    const stale = await json(
      t.send('POST', `/api/jobs/${job.id}/stale`, { reason: 'A target block was deleted.' }),
    )
    expect(stale.state).toBe('stale')
    expect(stale.rawOutput).toContain('WHY BLOCKS')
  })

  it('a restart marks unsettled jobs stale and keeps their output; dismissed jobs stay away', async () => {
    const reviewed = await start(request('fake:upper', byText('## Why blocks')))
    await runToReady(reviewed.id)
    const running = await start(request('fake:upper', byText('## A table')))
    await atCheckpoint(running.id)

    const restarted = createApp({
      workspace: t.workspace,
      workspacesFile: t.workspacesFile,
      workspacesDir: t.workspacesDir,
      fakeControl: false,
      allowedHosts: () => [],
    })
    try {
      const jobs = restarted.jobs.list()
      expect(jobs.map((job) => [job.id, job.state]).sort()).toEqual(
        [
          [reviewed.id, 'stale'],
          [running.id, 'stale'],
        ].sort(),
      )
      expect(jobs.find((job) => job.id === reviewed.id)?.rawOutput).toContain('WHY BLOCKS')
      restarted.jobs.dismiss(reviewed.id)
    } finally {
      void restarted.dispose()
    }
    const again = createApp({
      workspace: t.workspace,
      workspacesFile: t.workspacesFile,
      workspacesDir: t.workspacesDir,
      fakeControl: false,
      allowedHosts: () => [],
    })
    try {
      expect(again.jobs.list().map((job) => job.id)).toEqual([running.id])
    } finally {
      void again.dispose()
    }
  })
})

describe('agent-made links in the job directory are never followed', () => {
  // What an agent with a shell (codex, or a skill that allows Bash) can do inside its own
  // directory. The server must not turn those links into reads or writes outside it.
  let outside: string
  beforeEach(() => {
    outside = path.join(t.workspace, '..', `outside-${path.basename(t.workspace)}`)
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.png'), 'TOP SECRET')
    writeFileSync(path.join(outside, 'victim.txt'), 'victim\n')
  })
  afterEach(() => rmSync(outside, { recursive: true, force: true }))

  it('does not append progress through a symlinked progress.log', async () => {
    const job = await start(request('fake:upper', byText('## Why blocks')))
    await atCheckpoint(job.id)
    rmSync(path.join(jobDir(job.id), 'progress.log'), { force: true })
    symlinkSync(path.join(outside, 'victim.txt'), path.join(jobDir(job.id), 'progress.log'))
    t.gate.release(job.id)
    await until(job.id, 'ready')
    expect(readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('victim\n')
  })

  it('neither serves nor copies through a symlinked assets directory', async () => {
    const job = await start(request('fake:asset', byText('Results arrive')))
    await runToReady(job.id)
    rmSync(path.join(jobDir(job.id), 'assets'), { recursive: true })
    symlinkSync(outside, path.join(jobDir(job.id), 'assets'))
    // The job's own asset name now points outside too.
    writeFileSync(path.join(outside, 'fake-diagram.png'), 'OUTSIDE BYTES')

    expect((await t.get(`/api/jobs/${job.id}/assets/secret.png`)).status).toBe(400)
    const decide = await t.send('POST', `/api/jobs/${job.id}/decisions`, {
      accepted: [0],
      rejected: [],
    })
    expect(decide.status).toBe(400)
    const bundle = path.dirname(articlePath())
    expect(existsSync(path.join(bundle, 'fake-diagram.png'))).toBe(false)
  })

  it('does not disclose an outside file through a symlinked result.json', async () => {
    const job = await start(request('fake:upper', byText('## Why blocks')))
    await atCheckpoint(job.id)
    symlinkSync(path.join(outside, 'secret.png'), path.join(jobDir(job.id), 'result.json'))
    const cancelled = await json(t.send('POST', `/api/jobs/${job.id}/cancel`))
    expect(cancelled.state).toBe('cancelled')
    expect(JSON.stringify(cancelled)).not.toContain('TOP SECRET')
    const stale = await json(t.send('POST', `/api/jobs/${job.id}/stale`, { reason: 'x' }))
    expect(JSON.stringify(stale)).not.toContain('TOP SECRET')
  })

  it('rejects a result.json that is a link, as an invalid result', async () => {
    const job = await start(request('fake:hang', byText('## Why blocks')))
    await atCheckpoint(job.id)
    // The "agent" leaves a link instead of a file and exits: plant it, then let the run end.
    symlinkSync(path.join(outside, 'secret.png'), path.join(jobDir(job.id), 'result.json'))
    const entry = t.jobs as unknown as {
      readResult: (e: unknown) => { errors?: string[] }
      entries: Map<string, unknown>
    }
    const checked = entry.readResult(entry.entries.get(job.id))
    expect(checked.errors?.[0]).toContain('not a plain file')
    await t.send('POST', `/api/jobs/${job.id}/cancel`)
  })
})

describe('routes', () => {
  it.each(['/api/jobs/..%2f..%2fconfig', '/api/jobs/not-an-id'])(
    'rejects the job id in %s',
    async (url) => {
      expect((await t.get(url)).status).toBeGreaterThanOrEqual(400)
    },
  )

  it('serves job assets for ghost previews and refuses to leave assets/', async () => {
    const job = await start(request('fake:asset', byText('Results arrive')))
    await runToReady(job.id)
    expect((await t.get(`/api/jobs/${job.id}/assets/fake-diagram.png`)).status).toBe(200)
    expect((await t.get(`/api/jobs/${job.id}/assets/..%2fjob.json`)).status).toBe(400)
  })

  it('mounts the fake control route only with --fake-control', async () => {
    expect((await t.get('/api/__fake/waiting')).status).toBe(200)
    const plain = createTestApp()
    try {
      expect((await plain.get('/api/__fake/waiting')).status).toBe(404)
      expect((await plain.send('POST', '/api/__fake/release', {})).status).toBe(404)
      expect((await plain.send('POST', '/api/__fake/drop-events', {})).status).toBe(404)
    } finally {
      plain.cleanup()
    }
  })
})

describe('a workspace switch under the job manager', () => {
  const SAMPLE = path.resolve(import.meta.dirname, '..', '..', '..', 'sample-workspace')
  const SWITCHED = 'The workspace was switched.'

  let next: string
  beforeEach(() => {
    next = mkdtempSync(path.join(os.tmpdir(), 'openwrite-next-'))
    cpSync(SAMPLE, next, { recursive: true })
  })
  afterEach(() => rmSync(next, { recursive: true, force: true }))

  /** What `POST /api/workspaces/open` does, in the order that makes it safe. */
  const switchTo = async (root: string): Promise<void> => {
    await t.jobs.quiesce(SWITCHED)
    t.context.workspace.retarget(root)
    t.context.watcher.reset()
    t.jobs.rebind()
  }

  it('leaves the old workspace’s jobs behind, stale but intact', async () => {
    const job = await start(request('fake:upper', byText('## Why blocks')))
    await atCheckpoint(job.id)

    await switchTo(next)

    expect(t.jobs.list()).toEqual([])
    const onDisk = JSON.parse(readFileSync(path.join(jobDir(job.id), 'job.json'), 'utf8'))
    expect(onDisk.job.state).toBe('stale')
    expect(onDisk.job.error).toBe(SWITCHED)
    expect(existsSync(path.join(next, '.zen', 'jobs'))).toBe(false)
  })

  it('finds them again when the writer switches back', async () => {
    const job = await start(request('fake:upper', byText('## Why blocks')))
    await runToReady(job.id)

    await switchTo(next)
    expect(t.jobs.list()).toEqual([])

    await switchTo(t.workspace)
    const recovered = t.jobs.list()
    expect(recovered.map((entry) => entry.id)).toEqual([job.id])
    expect(recovered[0]?.state).toBe('stale')
    expect(recovered[0]?.rawOutput).toContain('WHY BLOCKS')
  })

  /**
   * The fake adapter, behind a cancel that can be told to do nothing — an agent whose stop is
   * slower than the switch's budget. Every call is counted either way.
   */
  const stubbornFake = (gate: FakeGate) => {
    const fake = createFakeAdapter(gate)
    const state = { stubborn: true, cancels: 0 }
    const adapter: AgentAdapter = {
      name: 'fake',
      start: (dir, options) => {
        const handle = fake.start(dir, options)
        return {
          ...handle,
          cancel: async (how) => {
            state.cancels++
            if (!state.stubborn) await handle.cancel(how)
          },
        }
      },
    }
    return { adapter, state }
  }

  it('stops a job started while the switch waited, which nothing else would reach', async () => {
    const gate = new FakeGate(true)
    const manager = new JobManager({
      workspace: t.context.workspace,
      events: t.context.events,
      registry: new AdapterRegistry().register(createFakeAdapter(gate)),
    })
    const early = manager.create(request('fake:upper', byText('## Why blocks')))
    await expect.poll(() => gate.waitingIds(), { timeout: 5000 }).toContain(early.id)

    const quiescing = manager.quiesce(SWITCHED, 100)
    const late = manager.create(request('fake:upper', byText('## A table')))
    await expect.poll(() => gate.waitingIds(), { timeout: 5000 }).toContain(late.id)
    await quiescing
    // The quiesce cancelled what it could see when it began: the late job was not there yet.
    expect(gate.waitingIds()).toEqual([late.id])

    t.context.workspace.retarget(next)
    manager.rebind()

    await expect.poll(() => gate.waitingIds(), { timeout: 5000 }).toEqual([])
    expect(manager.list()).toEqual([])
  })

  it('keeps an agent that outlived the switch cancellable by shutdown', async () => {
    const gate = new FakeGate(true)
    const { adapter, state } = stubbornFake(gate)
    const manager = new JobManager({
      workspace: t.context.workspace,
      events: t.context.events,
      registry: new AdapterRegistry().register(adapter),
    })
    const job = manager.create(request('fake:upper', byText('## Why blocks')))
    await expect.poll(() => gate.waitingIds(), { timeout: 5000 }).toContain(job.id)

    await manager.quiesce(SWITCHED, 100)
    t.context.workspace.retarget(next)
    manager.rebind()
    // Every cancel so far was ignored: the agent is still running, and its entry is gone.
    expect(state.cancels).toBeGreaterThan(0)
    expect(gate.waitingIds()).toEqual([job.id])
    expect(manager.list()).toEqual([])

    state.stubborn = false
    const before = state.cancels
    await manager.shutdown()
    expect(state.cancels).toBe(before + 1)
    expect(gate.waitingIds()).toEqual([])
  })

  it('never writes a job of the old workspace into the new one, however late it finishes', async () => {
    // A wedged agent: cancelling changes nothing and the run outlives the quiesce budget. Two
    // jobs of the old workspace are in flight — one started before the switch, one started while
    // the switch was waiting, which is the one no state check catches, because nothing ever
    // marked it stale. Both must finish without touching the workspace that is open now.
    let wedge = true
    const pending: ((completion: Completion) => void)[] = []
    const wedged: AgentAdapter = {
      name: 'fake',
      start: () => ({
        progress: (async function* () {})(),
        done: wedge
          ? new Promise<Completion>((resolve) => pending.push(resolve))
          : Promise.resolve({ ok: true }),
        cancel: async () => {},
      }),
    }
    const manager = new JobManager({
      workspace: t.context.workspace,
      events: t.context.events,
      registry: new AdapterRegistry().register(wedged),
    })

    const early = manager.create(request('x', byText('## Why blocks')))
    await expect.poll(() => pending.length, { timeout: 5000 }).toBe(1)

    const started = Date.now()
    const quiescing = manager.quiesce(SWITCHED, 100)
    const late = manager.create(request('x', byText('## A table')))
    await expect.poll(() => pending.length, { timeout: 5000 }).toBe(2)
    await quiescing
    // Golden rule 8: the switch waits for its budget, never for the agent.
    expect(Date.now() - started).toBeLessThan(2000)

    t.context.workspace.retarget(next)
    manager.rebind()

    wedge = false
    for (const resolve of pending) resolve({ ok: true })

    // A whole job of the new workspace runs to completion: the barrier that proves the two old
    // runs have had every chance to write something.
    const fresh = manager.create(request('x', byText('## Why blocks')))
    await expect.poll(() => manager.get(fresh.id).state, { timeout: 5000 }).toBe('failed')

    expect(readdirSync(path.join(next, '.zen', 'jobs'))).toEqual([fresh.id])
    expect(readdirSync(path.join(t.workspace, '.zen', 'jobs')).sort()).toEqual(
      [early.id, late.id].sort(),
    )
  })
})
