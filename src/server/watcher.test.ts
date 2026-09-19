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
    expect(seen).toEqual([])

    writeFileSync(article(), 'outside\n')
    await expect.poll(() => seen.length, { timeout: 3000 }).toBe(1)
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
