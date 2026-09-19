import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDoc, createIdMinter } from '../../shared/blocks/index.ts'
import type { ServerEvent } from '../../shared/events.ts'
import type { Job, JobRequest } from '../../shared/jobs/job-types.ts'
import { createApp } from '../app.ts'
import { createTestApp, json, type TestApp } from '../test-helpers.ts'

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

describe('the job file contract', () => {
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
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
    expect(t.jobs.get(job.id).result?.ops[0]).toMatchObject({ op: 'insert_after', block_id: 'b0' })
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
    await atCheckpoint(finished.id)
    t.gate.release(finished.id)
    await until(finished.id, 'ready')
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
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
    return t.jobs.get(job.id)
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
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
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
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
    const stale = await json(
      t.send('POST', `/api/jobs/${job.id}/stale`, { reason: 'A target block was deleted.' }),
    )
    expect(stale.state).toBe('stale')
    expect(stale.rawOutput).toContain('WHY BLOCKS')
  })

  it('a restart marks unsettled jobs stale and keeps their output; dismissed jobs stay away', async () => {
    const reviewed = await start(request('fake:upper', byText('## Why blocks')))
    await atCheckpoint(reviewed.id)
    t.gate.release(reviewed.id)
    await until(reviewed.id, 'ready')
    const running = await start(request('fake:upper', byText('## A table')))
    await atCheckpoint(running.id)

    const restarted = createApp({
      workspace: t.workspace,
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
      restarted.dispose()
    }
    const again = createApp({ workspace: t.workspace, fakeControl: false, allowedHosts: () => [] })
    try {
      expect(again.jobs.list().map((job) => job.id)).toEqual([running.id])
    } finally {
      again.dispose()
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
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
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
    await atCheckpoint(job.id)
    t.gate.release(job.id)
    await until(job.id, 'ready')
    expect((await t.get(`/api/jobs/${job.id}/assets/fake-diagram.png`)).status).toBe(200)
    expect((await t.get(`/api/jobs/${job.id}/assets/..%2fjob.json`)).status).toBe(400)
  })

  it('mounts the fake control route only with --fake-control', async () => {
    expect((await t.get('/api/__fake/waiting')).status).toBe(200)
    const plain = createTestApp()
    try {
      expect((await plain.get('/api/__fake/waiting')).status).toBe(404)
      expect((await plain.send('POST', '/api/__fake/release', {})).status).toBe(404)
    } finally {
      plain.cleanup()
    }
  })
})
