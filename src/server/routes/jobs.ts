import type { Hono } from 'hono'
import { z } from 'zod'
import { DecisionsRequestSchema, JobRequestSchema } from '../../shared/jobs/job-types.ts'
import type { FakeGate } from '../adapters/fake.ts'
import type { ServerContext } from '../context.ts'
import { contentTypeFor, HttpError, parseBody } from '../http.ts'
import { readJobAsset } from '../jobs/job-io.ts'
import type { JobManager } from '../jobs/manager.ts'
import { listSkills } from '../skills.ts'

export function mountJobRoutes(app: Hono, _context: ServerContext, jobs: JobManager): void {
  app.get('/api/jobs', (c) => c.json({ jobs: jobs.list() }))
  app.post('/api/jobs', async (c) => c.json(jobs.create(await parseBody(c, JobRequestSchema)), 201))
  app.get('/api/jobs/:id', (c) => c.json(jobs.get(c.req.param('id'))))
  app.post('/api/jobs/:id/cancel', async (c) => c.json(await jobs.cancel(c.req.param('id'))))

  app.post('/api/jobs/:id/decisions', async (c) => {
    const { accepted, rejected } = await parseBody(c, DecisionsRequestSchema)
    return c.json(jobs.decide(c.req.param('id'), accepted, rejected))
  })

  // The client reports what only it can know: a target block was deleted from the live document.
  app.post('/api/jobs/:id/stale', async (c) => {
    const { reason } = await parseBody(c, z.object({ reason: z.string().max(500) }))
    return c.json(jobs.markStale(c.req.param('id'), reason))
  })

  app.post('/api/jobs/:id/dismiss', (c) => {
    jobs.dismiss(c.req.param('id'))
    return c.json({ ok: true })
  })

  // Ghost previews load job assets from here until they are accepted into the bundle.
  app.get('/api/jobs/:id/assets/*', (c) => {
    const id = c.req.param('id')
    const prefix = `/api/jobs/${id}/assets/`
    const relative = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length))
    // Resolved from the trusted job directory and read without following links: `assets` itself
    // is agent-writable and may be a symlink.
    const data = readJobAsset(jobs.jobDir(id), `assets/${relative}`)
    if (data === null) throw new HttpError(404, 'asset not found')
    return c.body(new Uint8Array(data), 200, {
      'content-type': contentTypeFor(relative),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
  })

  app.get('/api/skills', (c) =>
    c.json({ skills: listSkills().map(({ body: _body, ...header }) => header) }),
  )
}

/** Test-only: mounted only with `--fake-control`. Lets e2e tests decide when a fake job finishes. */
export function mountFakeControl(app: Hono, gate: FakeGate): void {
  app.get('/api/__fake/waiting', (c) => c.json({ waiting: gate.waitingIds() }))
  app.post('/api/__fake/release', async (c) => {
    const { jobId } = await parseBody(c, z.object({ jobId: z.string().optional() }))
    return c.json({ released: gate.release(jobId) })
  })
}
