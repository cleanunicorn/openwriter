import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWorkspaceHeader, WORKSPACE_HEADER } from '../../shared/api-types.ts'
import { createTestApp, HOST, json, type TestApp } from '../test-helpers.ts'

// Issue #15, R3: a request admitted while workspace A was open must never run against B. A switch
// can complete while a body is still arriving, and `Workspace.retarget` moves the shared object in
// place; the base-hash guard alone does not cover it, because a document absent from both
// workspaces has a null hash in each.

const SAMPLE = path.resolve(import.meta.dirname, '..', '..', '..', 'sample-workspace')

let t: TestApp
let second: string
beforeEach(() => {
  t = createTestApp()
  second = path.join(t.workspacesDir, 'second')
  mkdirSync(t.workspacesDir, { recursive: true })
  cpSync(SAMPLE, second, { recursive: true })
})
afterEach(() => t.cleanup())

const openSecond = async () => {
  const res = await t.send('POST', '/api/workspaces/open', { name: 'second' })
  expect(res.status).toBe(200)
}

const named = (root: string) => ({ [WORKSPACE_HEADER]: encodeWorkspaceHeader(root) })

/**
 * A request whose body the test holds back: the route has been entered (and is waiting on the
 * body) once `reading` resolves, and it resumes only when `finish` sends the body.
 */
function heldBack(
  method: string,
  url: string,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  let reading!: () => void
  const started = new Promise<void>((resolve) => {
    reading = resolve
  })
  let send!: (body: Uint8Array) => void
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller) =>
        new Promise<void>((resolve) => {
          reading()
          send = (bytes) => {
            controller.enqueue(bytes)
            controller.close()
            resolve()
          }
        }),
    },
    { highWaterMark: 0 },
  )
  const response = t.app.request(url, {
    method,
    headers: { host: HOST, ...headers },
    body,
    // Node's fetch needs this for a streamed request body.
    duplex: 'half',
  } as RequestInit)
  return {
    started,
    finish: (value: unknown) => {
      send(value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value)))
      return response
    },
  }
}

const briefIn = (root: string, slug: string) =>
  path.join(root, '.zen', 'articles', slug, 'brief.md')

describe('a write admitted under one workspace, finished under another', () => {
  it('saves nothing when both hashes are null (a brief neither workspace has)', async () => {
    const put = heldBack('PUT', '/api/docs/brief/fresh-post')
    await put.started
    await openSecond()
    const res = await put.finish({ text: 'written in the first workspace\n', baseHash: null })

    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ workspaceChanged: true })
    expect(existsSync(briefIn(second, 'fresh-post'))).toBe(false)
    expect(existsSync(briefIn(t.workspace, 'fresh-post'))).toBe(false)
  })

  it('creates no article in the workspace that was opened meanwhile', async () => {
    const before = readdirSync(path.join(second, 'content', 'posts'))
    const post = heldBack('POST', '/api/articles')
    await post.started
    await openSecond()
    const res = await post.finish({ title: 'From the first workspace' })

    expect(res.status).toBe(409)
    expect(readdirSync(path.join(second, 'content', 'posts'))).toEqual(before)
  })

  it('stores no image in the workspace that was opened meanwhile', async () => {
    const bundle = path.join(second, 'content', 'posts', 'hello-openwrite')
    const before = readdirSync(bundle)
    const upload = heldBack('POST', '/api/docs/article/hello-openwrite/assets', {
      'content-type': 'image/png',
      'x-filename': 'late.png',
    })
    await upload.started
    await openSecond()
    const res = await upload.finish(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

    expect(res.status).toBe(409)
    expect(readdirSync(bundle)).toEqual(before)
  })

  it('saves no settings into the workspace that was opened meanwhile, even unnamed', async () => {
    const { config } = await json(t.get('/api/config'))
    const file = path.join(second, '.zen', 'config.json')
    const before = readFileSync(file, 'utf8')
    const put = heldBack('PUT', '/api/config')
    await put.started
    await openSecond()
    const res = await put.finish({ ...config, concurrency: 7 })

    expect(res.status).toBe(409)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('exports nothing from the workspace that was opened meanwhile', async () => {
    const post = heldBack('POST', '/api/export/markdown')
    await post.started
    await openSecond()
    const res = await post.finish({ slug: 'hello-openwrite' })
    expect(res.status).toBe(409)
  })

  it('starts no job in the workspace that was opened meanwhile', async () => {
    const post = heldBack('POST', '/api/jobs')
    await post.started
    await openSecond()
    const res = await post.finish({
      doc: { kind: 'article', slug: 'hello-openwrite' },
      scope: 'article',
      instruction: 'Tighten the intro',
      targets: [],
      snapshot: { blocks: [], gaps: [''] },
    })
    expect(res.status).toBe(409)
    expect(await json(t.get('/api/jobs'))).toEqual({ jobs: [] })
  })
})

describe('a request that names a workspace which is no longer open', () => {
  it('is refused for a read, a save and a new article, and nothing is written', async () => {
    const first = t.workspace
    await openSecond()
    const headers = { host: HOST, 'content-type': 'application/json', ...named(first) }

    const read = await t.app.request('/api/docs/article/hello-openwrite', { headers })
    expect(read.status).toBe(409)
    expect(await json(read)).toMatchObject({ workspaceChanged: true })

    const save = await t.app.request('/api/docs/brief/fresh-post', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ text: 'stale tab\n', baseHash: null }),
    })
    expect(save.status).toBe(409)
    expect(existsSync(briefIn(second, 'fresh-post'))).toBe(false)

    const create = await t.app.request('/api/articles', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Stale tab' }),
    })
    expect(create.status).toBe(409)
    expect(existsSync(path.join(second, 'content', 'posts', 'stale-tab'))).toBe(false)
  })

  it('is served when it names the workspace that is open', async () => {
    await openSecond()
    const res = await t.app.request('/api/docs/brief/fresh-post', {
      method: 'PUT',
      headers: { host: HOST, 'content-type': 'application/json', ...named(second) },
      body: JSON.stringify({ text: 'mine\n', baseHash: null }),
    })
    expect(res.status).toBe(200)
    expect(readFileSync(briefIn(second, 'fresh-post'), 'utf8')).toBe('mine\n')
  })

  it('refuses a header that does not decode, rather than treating it as absent', async () => {
    const res = await t.app.request('/api/docs/strategy', {
      headers: { host: HOST, [WORKSPACE_HEADER]: '%E0%A4%A' },
    })
    expect(res.status).toBe(409)
  })
})

afterEach(() => rmSync(second, { recursive: true, force: true }))
