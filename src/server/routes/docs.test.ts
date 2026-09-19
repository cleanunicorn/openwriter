import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../../shared/events.ts'
import { createTestApp, json, type TestApp } from '../test-helpers.ts'

let t: TestApp
beforeEach(() => {
  t = createTestApp()
})
afterEach(() => t.cleanup())

const article = (slug = 'hello-openwrite') =>
  path.join(t.workspace, 'content', 'posts', slug, 'index.md')

describe('documents', () => {
  it('serves the sample article, its brief, and the strategy', async () => {
    for (const url of [
      '/api/docs/article/hello-openwrite',
      '/api/docs/brief/hello-openwrite',
      '/api/docs/strategy',
    ]) {
      const doc = await json(t.get(url))
      expect(doc.exists).toBe(true)
      expect(doc.text.length).toBeGreaterThan(10)
    }
  })

  it('saves byte-identically and returns the new hash', async () => {
    const before = readFileSync(article())
    const doc = await json(t.get('/api/docs/article/hello-openwrite'))
    const res = await t.send('PUT', '/api/docs/article/hello-openwrite', {
      text: doc.text,
      baseHash: doc.hash,
    })
    expect(res.status).toBe(200)
    expect(readFileSync(article()).equals(before)).toBe(true)
  })

  it('keeps CRLF and a BOM through load and save', async () => {
    const text = '﻿# Title\r\n\r\nBody\r\n'
    writeFileSync(article(), text)
    const doc = await json(t.get('/api/docs/article/hello-openwrite'))
    expect(doc.text).toBe(text)
    await t.send('PUT', '/api/docs/article/hello-openwrite', { text: doc.text, baseHash: doc.hash })
    expect(readFileSync(article(), 'utf8')).toBe(text)
  })

  it('answers 409 with the disk version when the base hash is stale', async () => {
    const doc = await json(t.get('/api/docs/article/hello-openwrite'))
    writeFileSync(article(), 'changed outside\n')
    const res = await t.send('PUT', '/api/docs/article/hello-openwrite', {
      text: 'mine\n',
      baseHash: doc.hash,
    })
    expect(res.status).toBe(409)
    expect((await json(res)).text).toBe('changed outside\n')
    expect(readFileSync(article(), 'utf8')).toBe('changed outside\n')
  })

  it('never recreates a file that was deleted from outside', async () => {
    const doc = await json(t.get('/api/docs/article/hello-openwrite'))
    rmSync(article())
    const res = await t.send('PUT', '/api/docs/article/hello-openwrite', {
      text: doc.text,
      baseHash: doc.hash,
    })
    expect(res.status).toBe(409)
    expect((await json(res)).exists).toBe(false)
    expect(existsSync(article())).toBe(false)
  })

  it('refuses a file that is not UTF-8 and leaves it untouched', async () => {
    const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a])
    writeFileSync(article(), bytes)
    expect((await t.get('/api/docs/article/hello-openwrite')).status).toBe(422)
    const res = await t.send('PUT', '/api/docs/article/hello-openwrite', {
      text: 'x',
      baseHash: null,
    })
    expect(res.status).toBe(422)
    expect(readFileSync(article()).equals(bytes)).toBe(true)
  })

  it('never follows an index.md, strategy.md or brief.md that is a symlink out of the workspace', async () => {
    const outside = path.join(t.workspace, '..', `outside-${path.basename(t.workspace)}`)
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.md'), 'TOP SECRET\n')
    try {
      mkdirSync(path.join(t.workspace, 'content', 'posts', 'leak'))
      symlinkSync(path.join(outside, 'secret.md'), article('leak'))
      rmSync(path.join(t.workspace, 'strategy.md'))
      symlinkSync(path.join(outside, 'secret.md'), path.join(t.workspace, 'strategy.md'))

      for (const url of ['/api/docs/article/leak', '/api/docs/strategy']) {
        const res = await t.get(url)
        expect(res.status).toBe(400)
        expect(await res.text()).not.toContain('TOP SECRET')
      }
      // Not listed, not written through.
      expect(
        (await json(t.get('/api/articles'))).articles.map((a: { slug: string }) => a.slug),
      ).toEqual(['hello-openwrite'])
      const put = await t.send('PUT', '/api/docs/article/leak', {
        text: 'overwrite',
        baseHash: null,
      })
      expect(put.status).toBe(400)
      expect(readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('TOP SECRET\n')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.each([
    '/api/docs/article/..%2f..%2fstrategy',
    '/api/docs/article/UPPER',
    '/api/docs/brief/a.b',
    '/api/docs/nonsense/x',
  ])('rejects %s', async (url) => {
    expect((await t.get(url)).status).toBe(400)
  })

  it('creates the brief on first save', async () => {
    const created = await json(t.send('POST', '/api/articles', { title: 'Second Post!' }))
    expect(created.slug).toBe('second-post')
    const res = await t.send('PUT', '/api/docs/brief/second-post', {
      text: 'Angle\n',
      baseHash: null,
    })
    expect(res.status).toBe(409) // createArticle already wrote an empty brief
    const brief = await json(t.get('/api/docs/brief/second-post'))
    const ok = await t.send('PUT', '/api/docs/brief/second-post', {
      text: 'Angle\n',
      baseHash: brief.hash,
    })
    expect(ok.status).toBe(200)
  })
})

describe('articles', () => {
  it('lists articles with the front matter title', async () => {
    const { articles } = await json(t.get('/api/articles'))
    expect(articles).toEqual([{ slug: 'hello-openwrite', title: 'Hello, openwrite' }])
  })

  it('creates a new article as a leaf bundle and de-duplicates the slug', async () => {
    const first = await json(t.send('POST', '/api/articles', { title: 'My Post' }))
    const second = await json(t.send('POST', '/api/articles', { title: 'My Post' }))
    expect([first.slug, second.slug]).toEqual(['my-post', 'my-post-2'])
    expect(readFileSync(article('my-post'), 'utf8')).toContain('title: "My Post"')
  })

  it('follows a configured content directory', async () => {
    const config = path.join(t.workspace, '.zen', 'config.json')
    writeFileSync(config, JSON.stringify({ contentDir: 'site/content' }))
    await t.send('POST', '/api/articles', { title: 'Elsewhere' })
    expect(
      existsSync(path.join(t.workspace, 'site', 'content', 'posts', 'elsewhere', 'index.md')),
    ).toBe(true)
  })
})

describe('assets', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
  const upload = (name: string, body: Uint8Array, type = 'image/png') =>
    t.app.request('/api/docs/article/hello-openwrite/assets', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4317',
        'content-type': type,
        'x-filename': encodeURIComponent(name),
      },
      body,
    })

  it('stores a pasted image in the bundle under a sanitised name', async () => {
    const res = await upload('../../My Shot (1).PNG', png)
    expect(res.status).toBe(201)
    const { name } = await json(res)
    expect(name).toBe('my-shot-1.png')
    expect(existsSync(path.join(path.dirname(article()), name))).toBe(true)
    expect(existsSync(path.join(t.workspace, 'My Shot (1).PNG'))).toBe(false)
  })

  it('reuses identical content and renames different content', async () => {
    const a = await json(upload('shot.png', png))
    const b = await json(upload('shot.png', png))
    const c = await json(upload('shot.png', Buffer.concat([png, Buffer.from([0])])))
    expect([a.name, b.name, c.name]).toEqual(['shot.png', 'shot.png', 'shot-2.png'])
  })

  it('rejects anything that is not an image', async () => {
    expect((await upload('x.html', Buffer.from('<script>'), 'text/html')).status).toBe(415)
  })

  it('serves bundle assets and refuses to leave the bundle', async () => {
    const ok = await t.get('/api/docs/article/hello-openwrite/assets/pixel.png')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    const escaping = await t.get(
      '/api/docs/article/hello-openwrite/assets/..%2f..%2f..%2fstrategy.md',
    )
    expect(escaping.status).toBe(400)
  })

  it('answers 400, not 500, for a malformed percent-escape', async () => {
    expect((await t.get('/api/docs/article/hello-openwrite/assets/100%.png')).status).toBe(400)
    expect((await t.get('/api/jobs/20260101-000000-abcd/assets/100%.png')).status).toBe(400)
  })

  it('refuses a symlink that points out of the bundle', async () => {
    const outside = path.join(t.workspace, '..', `outside-${path.basename(t.workspace)}`)
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.png'), 'secret')
    symlinkSync(outside, path.join(path.dirname(article()), 'link'))
    try {
      expect((await t.get('/api/docs/article/hello-openwrite/assets/link/secret.png')).status).toBe(
        400,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('watching', () => {
  it('emits doc.changed for an outside change and stays quiet for its own write', async () => {
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    const doc = await json(t.get('/api/docs/article/hello-openwrite'))

    await t.send('PUT', '/api/docs/article/hello-openwrite', {
      text: `${doc.text}\nmine\n`,
      baseHash: doc.hash,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen).toEqual([])

    writeFileSync(article(), 'outside\n')
    await expect.poll(() => seen.length, { timeout: 3000 }).toBe(1)
    expect(seen[0]).toMatchObject({
      type: 'doc.changed',
      ref: { kind: 'article', slug: 'hello-openwrite' },
    })
  })
})

describe('config', () => {
  it('returns the sample config with the forced adapter', async () => {
    const body = await json(t.get('/api/config'))
    expect(body.config.mainAgent).toBe('fake')
    expect(body.adapterOverride).toBe('fake')
    expect(body.contentOutsideWorkspace).toBe(false)
  })

  it('never overwrites an invalid config file', async () => {
    const file = path.join(t.workspace, '.zen', 'config.json')
    writeFileSync(file, '{ "concurrency": "many" }')
    const body = await json(t.get('/api/config'))
    expect(body.error).toContain('concurrency')
    expect(body.config.concurrency).toBe(3)
    const res = await t.send('PUT', '/api/config', body.config)
    expect(res.status).toBe(409)
    expect(readFileSync(file, 'utf8')).toBe('{ "concurrency": "many" }')
  })

  it('refuses a relative content directory that leaves the workspace, and writes nothing', async () => {
    const file = path.join(t.workspace, '.zen', 'config.json')
    const before = readFileSync(file, 'utf8')
    const { config } = await json(t.get('/api/config'))
    const res = await t.send('PUT', '/api/config', { ...config, contentDir: '../hugo/content' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('use an absolute path')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await t.get('/api/articles')).status).toBe(200)
  })

  it('stays usable when such a value was written by hand, so settings can repair it', async () => {
    writeFileSync(
      path.join(t.workspace, '.zen', 'config.json'),
      JSON.stringify({ contentDir: '../hugo/content' }),
    )
    const body = await json(t.get('/api/config'))
    expect(body.contentDirError).toContain('leaves the workspace')
    expect(body.error).toBeNull()
    expect(await json(t.get('/api/articles'))).toEqual({ articles: [] })
    const repaired = await t.send('PUT', '/api/config', { ...body.config, contentDir: 'content' })
    expect(repaired.status).toBe(200)
    expect((await json(t.get('/api/articles'))).articles).toHaveLength(1)
  })

  it('saves a valid config and reports an absolute content directory', async () => {
    const { config } = await json(t.get('/api/config'))
    const outside = path.join(t.workspace, '..', `hugo-${path.basename(t.workspace)}`)
    mkdirSync(outside)
    try {
      const res = await t.send('PUT', '/api/config', {
        ...config,
        mainAgent: 'codex',
        contentDir: outside,
      })
      const body = await json(res)
      expect(body.config.mainAgent).toBe('codex')
      expect(body.contentOutsideWorkspace).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
