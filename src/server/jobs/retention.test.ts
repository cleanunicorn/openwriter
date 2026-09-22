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
import { encodeWorkspaceHeader, WORKSPACE_HEADER } from '../../shared/api-types.ts'
import { createDoc, createIdMinter } from '../../shared/blocks/index.ts'
import type { ServerEvent } from '../../shared/events.ts'
import type { Job, JobRequest, JobState } from '../../shared/jobs/job-types.ts'
import { createFakeAdapter, FakeGate } from '../adapters/fake.ts'
import { AdapterRegistry } from '../adapters/registry.ts'
import type { AgentAdapter } from '../adapters/types.ts'
import { createApp } from '../app.ts'
import { createTestApp, HOST, json, type TestApp } from '../test-helpers.ts'
import { JobManager } from './manager.ts'
import { isExpired, pruneExpiredJobs } from './retention.ts'
import type { JobFile } from './store.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-22T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString()

let counter = 0
/** A job.json as the server writes it, in any state and of any age. */
function jobFile(state: JobState, updatedAt: string, dismissed = false, id?: string): JobFile {
  const jobId = id ?? `20260101-000000-${(counter++).toString(36).padStart(4, '0')}`
  return {
    version: 1,
    job: {
      id: jobId,
      doc: { kind: 'article', slug: 'hello-openwrite' },
      scope: 'blocks',
      instruction: 'x',
      skill: null,
      adapter: 'fake',
      state,
      reason: null,
      error: null,
      targets: [],
      owner: null,
      snapshotRaws: {},
      result: null,
      rawOutput: null,
      decisions: {},
      progress: [],
      revision: 1,
      createdAt: updatedAt,
      updatedAt,
    },
    effectiveConfig: { adapter: { extraArgs: [] }, timeoutSec: 600 },
    promoted: {},
    dismissed,
  }
}

function plant(jobsDir: string, file: JobFile): string {
  const dir = path.join(jobsDir, file.job.id)
  mkdirSync(path.join(dir, 'assets'), { recursive: true })
  writeFileSync(path.join(dir, 'job.json'), JSON.stringify(file))
  writeFileSync(path.join(dir, 'assets', 'a.png'), 'png')
  return file.job.id
}

describe('the retention rule', () => {
  it.each<[JobState, boolean, boolean]>([
    ['settled', false, true],
    ['failed', false, true],
    ['cancelled', false, true],
    // A stale job is on screen "so nothing is lost": only the writer clears it, or dismisses it.
    ['stale', false, false],
    ['stale', true, true],
    ['ready', false, false],
    ['ready', true, false],
    ['queued', true, false],
    ['running', false, false],
    ['validating', false, false],
    ['repairing', false, false],
  ])('a %s job (dismissed: %s) older than the limit is pruned: %s', (state, dismissed, pruned) => {
    expect(isExpired(jobFile(state, daysAgo(31), dismissed), NOW, 30)).toBe(pruned)
  })

  it('keeps anything younger than the limit, and everything when the limit is 0', () => {
    expect(isExpired(jobFile('settled', daysAgo(29)), NOW, 30)).toBe(false)
    expect(isExpired(jobFile('settled', daysAgo(3000)), NOW, 0)).toBe(false)
  })

  it('does not treat an unreadable timestamp as old', () => {
    expect(isExpired(jobFile('settled', 'not a date'), NOW, 30)).toBe(false)
  })
})

describe('pruning at open', () => {
  let base: string
  let jobsDir: string
  beforeEach(() => {
    base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-prune-'))
    jobsDir = path.join(base, '.zen', 'jobs')
    mkdirSync(jobsDir, { recursive: true })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('removes old finished jobs and keeps the rest', () => {
    const old = plant(jobsDir, jobFile('settled', daysAgo(40)))
    const young = plant(jobsDir, jobFile('failed', daysAgo(2)))
    const review = plant(jobsDir, jobFile('ready', daysAgo(400)))
    const stale = plant(jobsDir, jobFile('stale', daysAgo(400)))
    expect(pruneExpiredJobs(jobsDir, 30, NOW)).toEqual([old])
    expect(readdirSync(jobsDir).sort()).toEqual([young, review, stale].sort())
  })

  it('never reads through or deletes a symlink, and ignores names that are not job ids', () => {
    const outside = path.join(base, 'outside')
    plant(outside, jobFile('settled', daysAgo(40), false, '20260101-000000-zzzz'))
    symlinkSync(
      path.join(outside, '20260101-000000-zzzz'),
      path.join(jobsDir, '20260101-000000-zzzz'),
    )
    mkdirSync(path.join(jobsDir, 'notes'))
    writeFileSync(
      path.join(jobsDir, 'notes', 'job.json'),
      JSON.stringify(jobFile('settled', daysAgo(40))),
    )
    expect(pruneExpiredJobs(jobsDir, 30, NOW)).toEqual([])
    expect(existsSync(path.join(outside, '20260101-000000-zzzz', 'assets', 'a.png'))).toBe(true)
    expect(existsSync(path.join(jobsDir, 'notes', 'job.json'))).toBe(true)
  })

  it('keeps a directory whose job.json names another job, or does not parse', () => {
    const file = jobFile('settled', daysAgo(40))
    const dir = path.join(jobsDir, '20260101-000000-othr')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'job.json'), JSON.stringify(file))
    const broken = path.join(jobsDir, '20260101-000000-brkn')
    mkdirSync(broken)
    writeFileSync(path.join(broken, 'job.json'), '{ not json')
    expect(pruneExpiredJobs(jobsDir, 30, NOW)).toEqual([])
    expect(existsSync(dir) && existsSync(broken)).toBe(true)
  })

  it('does nothing without a jobs directory, or with retention off', () => {
    expect(pruneExpiredJobs(path.join(base, 'missing'), 30, NOW)).toEqual([])
    plant(jobsDir, jobFile('settled', daysAgo(4000)))
    expect(pruneExpiredJobs(jobsDir, 0, NOW)).toEqual([])
    expect(readdirSync(jobsDir)).toHaveLength(1)
  })

  it('runs when the server starts, with the workspace’s own retention setting', () => {
    const workspace = path.join(base, 'ws')
    cpSync(path.resolve(import.meta.dirname, '..', '..', '..', 'sample-workspace'), workspace, {
      recursive: true,
    })
    const wsJobs = path.join(workspace, '.zen', 'jobs')
    const expired = plant(
      wsJobs,
      jobFile('cancelled', new Date(Date.now() - 8 * DAY).toISOString()),
    )
    const kept = plant(wsJobs, jobFile('cancelled', new Date(Date.now() - 6 * DAY).toISOString()))
    const config = path.join(workspace, '.zen', 'config.json')
    const current = JSON.parse(readFileSync(config, 'utf8'))
    writeFileSync(config, JSON.stringify({ ...current, jobRetentionDays: 7 }))
    const app = createApp({
      workspace,
      workspacesFile: path.join(base, 'workspaces.json'),
      workspacesDir: path.join(base, 'workspaces'),
      fakeControl: false,
      allowedHosts: () => [],
    })
    try {
      expect(existsSync(path.join(wsJobs, expired))).toBe(false)
      expect(existsSync(path.join(wsJobs, kept))).toBe(true)
    } finally {
      void app.dispose()
    }
  })
})

describe('clearing finished jobs', () => {
  let t: TestApp
  beforeEach(() => {
    t = createTestApp({ fakeControl: true })
  })
  afterEach(() => t.cleanup())

  const jobsDir = () => path.join(t.workspace, '.zen', 'jobs')
  const onDisk = () => (existsSync(jobsDir()) ? readdirSync(jobsDir()).sort() : [])

  function request(instruction: string, heading: string): JobRequest {
    const article = path.join(t.workspace, 'content', 'posts', 'hello-openwrite', 'index.md')
    const doc = createDoc(readFileSync(article, 'utf8'), createIdMinter())
    const target = doc.blocks.find((block) => block.raw.includes(heading))
    return {
      doc: { kind: 'article', slug: 'hello-openwrite' },
      scope: 'blocks',
      instruction,
      targets: [target?.id ?? 'b999'],
      snapshot: doc,
    }
  }
  async function start(instruction: string, heading: string): Promise<Job> {
    const res = await t.send('POST', '/api/jobs', request(instruction, heading))
    expect(res.status).toBe(201)
    return json(res)
  }
  const until = (id: string, wanted: Job['state']) =>
    expect.poll(() => t.jobs.get(id).state, { timeout: 5000 }).toBe(wanted)
  const atCheckpoint = (id: string) =>
    expect.poll(() => t.gate.waitingIds(), { timeout: 5000 }).toContain(id)
  const release = async (id: string, wanted: Job['state']) => {
    await atCheckpoint(id)
    t.gate.release(id)
    await until(id, wanted)
  }
  const clear = async (root = t.workspace) =>
    t.app.request('/api/jobs/clear-finished', {
      method: 'POST',
      headers: {
        host: HOST,
        'content-type': 'application/json',
        [WORKSPACE_HEADER]: encodeWorkspaceHeader(root),
      },
      body: '{}',
    })

  it('deletes every finished job and keeps queued, running and reviewable ones', async () => {
    writeFileSync(
      path.join(t.workspace, '.zen', 'config.json'),
      JSON.stringify({ mainAgent: 'fake', concurrency: 1 }),
    )
    // settled
    const settled = await start('fake:upper', '## Why blocks')
    await release(settled.id, 'ready')
    await json(t.send('POST', `/api/jobs/${settled.id}/decisions`, { accepted: [], rejected: [0] }))
    expect(t.jobs.get(settled.id).state).toBe('settled')
    // failed
    const failed = await start('fake:fail', '## Why blocks')
    await release(failed.id, 'failed')
    // stale, and dismissed on top
    const stale = await start('fake:upper', '## Why blocks')
    await release(stale.id, 'ready')
    await t.send('POST', `/api/jobs/${stale.id}/stale`, { reason: 'gone' })
    await t.send('POST', `/api/jobs/${stale.id}/dismiss`)
    // ready: awaiting review
    const ready = await start('fake:upper', '## A table')
    await release(ready.id, 'ready')
    // running, and queued behind it (one slot)
    const running = await start('fake:upper', '## Why blocks')
    await atCheckpoint(running.id)
    const queued = await start('fake:upper', '## Why blocks')
    expect(t.jobs.get(queued.id).state).toBe('queued')
    // cancelled while queued: finished, and its agent never started
    const cancelled = await start('fake:upper', '## Why blocks')
    await t.send('POST', `/api/jobs/${cancelled.id}/cancel`)
    expect(t.jobs.get(cancelled.id).state).toBe('cancelled')
    // A finished job of an earlier session: on disk only, never loaded.
    const earlier = plant(jobsDir(), jobFile('settled', daysAgo(1)))

    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    const res = await clear()
    expect(res.status).toBe(200)
    const body = await json(res)
    const gone = [settled.id, failed.id, stale.id, cancelled.id, earlier].sort()
    expect([...body.removed].sort()).toEqual(gone)
    expect(body.kept).toBe(3)
    expect(body.skipped).toEqual([])
    expect(onDisk()).toEqual([ready.id, running.id, queued.id].sort())
    expect(seen).toContainEqual({ type: 'job.removed', ids: body.removed })
    expect(
      t.jobs
        .list()
        .map((job) => job.id)
        .sort(),
    ).toEqual([ready.id, running.id, queued.id].sort())
    expect((await t.get(`/api/jobs/${settled.id}`)).status).toBe(404)

    // What was kept still works: the queued job runs once the slot frees.
    await release(running.id, 'ready')
    await release(queued.id, 'ready')
    // A second clear has nothing to do and says so.
    const again = await json(clear())
    expect(again).toEqual({ removed: [], kept: 3, skipped: [] })
  })

  it('reports and leaves alone a symlinked job directory and one it cannot read', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'openwrite-outside-'))
    try {
      const target = plant(outside, jobFile('settled', daysAgo(1), false, '20260101-000000-link'))
      mkdirSync(jobsDir(), { recursive: true })
      symlinkSync(path.join(outside, target), path.join(jobsDir(), target))
      const broken = path.join(jobsDir(), '20260101-000000-brkn')
      mkdirSync(broken)
      writeFileSync(path.join(broken, 'job.json'), '{')
      mkdirSync(path.join(jobsDir(), 'not-a-job'))

      const body = await json(clear())
      expect(body.removed).toEqual([])
      expect(body.skipped.map((entry: { id: string }) => entry.id).sort()).toEqual(
        ['20260101-000000-brkn', target].sort(),
      )
      expect(existsSync(path.join(outside, target, 'assets', 'a.png'))).toBe(true)
      expect(onDisk()).toEqual(['20260101-000000-brkn', target, 'not-a-job'].sort())
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('succeeds with nothing to do when the workspace has no jobs directory', async () => {
    expect(existsSync(jobsDir())).toBe(false)
    expect(await json(clear())).toEqual({ removed: [], kept: 0, skipped: [] })
  })

  it('refuses a request meant for a workspace that is no longer open', async () => {
    const failed = await start('fake:fail', '## Why blocks')
    await release(failed.id, 'failed')
    const res = await clear('/somewhere/else')
    expect(res.status).toBe(409)
    expect(onDisk()).toEqual([failed.id])
  })

  it('keeps a cancelled job whose agent has not exited yet, and clears it once it has', async () => {
    const gate = new FakeGate(true)
    const fake = createFakeAdapter(gate)
    // An agent that ignores its stop: the job is cancelled, the process is still writing.
    const stubborn: AgentAdapter = {
      name: 'fake',
      start: (dir, options) => ({ ...fake.start(dir, options), cancel: async () => {} }),
    }
    const manager = new JobManager({
      workspace: t.context.workspace,
      events: t.context.events,
      registry: new AdapterRegistry().register(stubborn),
    })
    const job = manager.create(request('fake:upper', '## Why blocks'))
    await expect.poll(() => gate.waitingIds(), { timeout: 5000 }).toContain(job.id)
    expect((await manager.cancel(job.id)).state).toBe('cancelled')

    expect(manager.clearFinished()).toEqual({ removed: [], kept: 1, skipped: [] })
    expect(onDisk()).toEqual([job.id])

    gate.release(job.id)
    await expect.poll(() => manager.clearFinished().removed, { timeout: 5000 }).toEqual([job.id])
    expect(onDisk()).toEqual([])
    // The run that was still settling writes nothing back: wait for it, then look again.
    await manager.quiesce('done', 5000)
    expect(onDisk()).toEqual([])
  })

  it('after a workspace switch, clears only the open workspace’s jobs, and prunes the new one', async () => {
    const failed = await start('fake:fail', '## Why blocks')
    await release(failed.id, 'failed')

    const next = mkdtempSync(path.join(os.tmpdir(), 'openwrite-next-'))
    try {
      cpSync(path.resolve(import.meta.dirname, '..', '..', '..', 'sample-workspace'), next, {
        recursive: true,
      })
      const nextJobs = path.join(next, '.zen', 'jobs')
      const expired = plant(
        nextJobs,
        jobFile('settled', new Date(Date.now() - 90 * DAY).toISOString()),
      )
      const recent = plant(nextJobs, jobFile('failed', new Date().toISOString()))

      await t.jobs.quiesce('switched')
      t.context.workspace.retarget(next)
      t.context.watcher.reset()
      t.jobs.rebind()
      // Pruned on open: the default keeps 30 days.
      expect(readdirSync(nextJobs)).toEqual([recent])

      // The tab still showing the old workspace is refused; the new one clears its own jobs.
      expect((await clear(t.workspace)).status).toBe(409)
      const body = await json(clear(next))
      expect(body.removed).toEqual([recent])
      expect(existsSync(nextJobs) && readdirSync(nextJobs)).toEqual([])
      // The workspace that was left keeps its job directory.
      expect(onDisk()).toEqual([failed.id])
      expect(expired).not.toBe(recent)
    } finally {
      rmSync(next, { recursive: true, force: true })
    }
  })
})
