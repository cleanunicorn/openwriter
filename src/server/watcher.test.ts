import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from '../shared/events.ts'
import { createTestApp, json, type TestApp } from './test-helpers.ts'

let t: TestApp
beforeEach(() => {
  t = createTestApp()
})
afterEach(() => t.cleanup())

const article = (slug = 'hello-openwrite') =>
  path.join(t.workspace, 'content', 'posts', slug, 'index.md')

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
    // The save route announces its own write (#29, routes/docs.test.ts); the watcher adds nothing.
    expect(seen).toHaveLength(1)
    seen.length = 0

    writeFileSync(article(), 'outside\n')
    await expect.poll(() => seen.length, { timeout: 3000 }).toBe(1)
    expect(seen[0]).not.toHaveProperty('origin')
    expect(seen[0]).toMatchObject({
      type: 'doc.changed',
      ref: { kind: 'article', slug: 'hello-openwrite' },
    })
  })
})

describe('watching across a content directory change', () => {
  it('stops watching the old directory and follows the new one', async () => {
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    await t.get('/api/docs/article/hello-openwrite')

    // Move the content root; the same slug now lives elsewhere.
    const moved = path.join(t.workspace, 'site', 'content', 'posts', 'hello-openwrite')
    mkdirSync(moved, { recursive: true })
    writeFileSync(path.join(moved, 'index.md'), '# Moved\n')
    const { config } = await json(t.get('/api/config'))
    await t.send('PUT', '/api/config', { ...config, contentDir: 'site/content' })
    await t.get('/api/docs/article/hello-openwrite')
    seen.length = 0

    // A change in the OLD location is no longer this document's business…
    writeFileSync(article(), 'old location changed\n')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(seen.filter((event) => event.type === 'doc.changed')).toEqual([])
    // …a change in the new one is, exactly once.
    writeFileSync(path.join(moved, 'index.md'), '# Moved and changed\n')
    await expect
      .poll(() => seen.filter((event) => event.type === 'doc.changed').length, { timeout: 3000 })
      .toBe(1)
  })
})

describe('open documents across a content directory change, before anything reads them again', () => {
  const changed = (seen: ServerEvent[]) => seen.filter((event) => event.type === 'doc.changed')
  const moveContentDir = async () => {
    const moved = path.join(t.workspace, 'site', 'content', 'posts', 'hello-openwrite')
    mkdirSync(moved, { recursive: true })
    writeFileSync(path.join(moved, 'index.md'), '# Moved\n')
    const { config } = await json(t.get('/api/config'))
    const res = await t.send('PUT', '/api/config', { ...config, contentDir: 'site/content' })
    expect(res.status).toBe(200)
    return path.join(moved, 'index.md')
  }

  it('says at once that an open article now resolves to a different file', async () => {
    // The client keeps the article open and reads nothing on `config.changed`, so the server is
    // the one that knows the slug now means another file. It says so the way it says every
    // other outside change: one `doc.changed`, carrying the new file's hash.
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    await t.get('/api/docs/article/hello-openwrite')
    await moveContentDir()
    await expect.poll(() => changed(seen).length, { timeout: 3000 }).toBe(1)
    const disk = await json(t.get('/api/docs/article/hello-openwrite'))
    expect(changed(seen)[0]).toMatchObject({
      ref: { kind: 'article', slug: 'hello-openwrite' },
      hash: disk.hash,
    })
  })

  it('keeps watching an open article at its new path', async () => {
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    await t.get('/api/docs/article/hello-openwrite')
    const moved = await moveContentDir()
    await expect.poll(() => changed(seen).length, { timeout: 3000 }).toBe(1)

    // Nothing reads the article again: the watcher alone has to notice.
    writeFileSync(moved, '# Moved and changed outside\n')
    await expect.poll(() => changed(seen).length, { timeout: 3000 }).toBe(2)
    // The old location is no longer this document's business.
    writeFileSync(article(), 'old location changed\n')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(changed(seen)).toHaveLength(2)
  })

  it('keeps watching an open document whose path did not move with it', async () => {
    // strategy.md lives at the workspace root, whatever `contentDir` says; forgetting it on a
    // content directory change blinded the watcher to it for no reason at all.
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    await t.get('/api/docs/strategy')
    await moveContentDir()
    writeFileSync(path.join(t.workspace, 'strategy.md'), '# Strategy, changed outside\n')
    await expect.poll(() => changed(seen).length, { timeout: 3000 }).toBe(1)
    expect(changed(seen)[0]).toMatchObject({ ref: { kind: 'strategy' } })
  })
})

describe('watching across a settings save', () => {
  it('keeps watching an open document when the content directory did not change', async () => {
    const seen: ServerEvent[] = []
    t.context.events.subscribe((event) => seen.push(event))
    await t.get('/api/docs/article/hello-openwrite')

    // A panel toggle is a config save that changes only `ui`.
    const { config } = await json(t.get('/api/config'))
    const res = await t.send('PUT', '/api/config', { ...config, ui: { leftPanel: true } })
    expect(res.status).toBe(200)

    writeFileSync(article(), 'changed outside after the save\n')
    await expect
      .poll(() => seen.filter((event) => event.type === 'doc.changed').length, { timeout: 3000 })
      .toBe(1)
  })
})
