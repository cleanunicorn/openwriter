import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contrast, WCAG_AA } from '../shared/contrast.ts'
import { EXPORT_STYLESHEET } from './export.ts'
import { createTestApp, type TestApp } from './test-helpers.ts'

let t: TestApp
beforeEach(() => {
  t = createTestApp()
})
afterEach(() => t.cleanup())

const bundle = () => path.join(t.workspace, 'content', 'posts', 'hello-openwrite')
const unzip = async (response: Response) => unzipSync(new Uint8Array(await response.arrayBuffer()))

describe('markdown export', () => {
  it('zips the bundle as is: exact markdown bytes, every asset, nested paths', async () => {
    mkdirSync(path.join(bundle(), 'img'))
    writeFileSync(path.join(bundle(), 'img', 'unreferenced.txt'), 'kept')
    const response = await t.send('POST', '/api/export/markdown', { slug: 'hello-openwrite' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('hello-openwrite-markdown.zip')
    const files = await unzip(response)
    expect(Object.keys(files).sort()).toEqual([
      'hello-openwrite/img/unreferenced.txt',
      'hello-openwrite/index.md',
      'hello-openwrite/pixel.png',
    ])
    expect(
      Buffer.from(files['hello-openwrite/index.md'] as Uint8Array).equals(
        readFileSync(path.join(bundle(), 'index.md')),
      ),
    ).toBe(true)
  })

  it('never follows a symlink out of the bundle, and never includes .zen', async () => {
    symlinkSync(path.join(t.workspace, 'strategy.md'), path.join(bundle(), 'leak.md'))
    symlinkSync(path.join(t.workspace, '.zen'), path.join(bundle(), 'zen'))
    const files = await unzip(
      await t.send('POST', '/api/export/markdown', { slug: 'hello-openwrite' }),
    )
    expect(Object.keys(files).sort()).toEqual([
      'hello-openwrite/index.md',
      'hello-openwrite/pixel.png',
    ])
  })

  it('rejects a bad slug and an unknown article', async () => {
    expect((await t.send('POST', '/api/export/markdown', { slug: '../..' })).status).toBe(400)
    expect((await t.send('POST', '/api/export/markdown', { slug: 'nope' })).status).toBe(404)
  })
})

describe('html export', () => {
  it('wraps the rendered body in a standalone page with one stylesheet and the assets', async () => {
    const html =
      '<h1>Hello</h1><p><img src="pixel.png" alt="px"></p><div class="diagram"><svg><text>Writer</text></svg></div>'
    const response = await t.send('POST', '/api/export/html', {
      slug: 'hello-openwrite',
      title: 'Hello & <co>',
      html,
    })
    const files = await unzip(response)
    expect(Object.keys(files).sort()).toEqual([
      'hello-openwrite/index.html',
      'hello-openwrite/pixel.png',
      'hello-openwrite/style.css',
    ])
    const page = strFromU8(files['hello-openwrite/index.html'] as Uint8Array)
    expect(page).toContain('<title>Hello &amp; &lt;co&gt;</title>')
    expect(page).toContain('<link rel="stylesheet" href="style.css">')
    expect(page).toContain('<svg><text>Writer</text></svg>')
    // Standalone: no script, no remote reference.
    expect(page).not.toMatch(/<script|https?:\/\//)
    expect(strFromU8(files['hello-openwrite/style.css'] as Uint8Array)).toContain('680px')
  })

  it('works for an article without assets', async () => {
    await t.send('POST', '/api/articles', { title: 'Bare' })
    const files = await unzip(
      await t.send('POST', '/api/export/html', { slug: 'bare', title: 'Bare', html: '<p>x</p>' }),
    )
    expect(Object.keys(files).sort()).toEqual(['bare/index.html', 'bare/style.css'])
  })
})

describe('export stylesheet', () => {
  it('is baked light: no dark variant that the baked-light diagrams would contradict', () => {
    expect(EXPORT_STYLESHEET).toContain('color-scheme: light;')
    expect(EXPORT_STYLESHEET).not.toContain('prefers-color-scheme')
  })

  it('every text colour meets WCAG AA on the page and on code backgrounds', () => {
    const colours = [...EXPORT_STYLESHEET.matchAll(/[\s{;]color:\s*(#[0-9a-f]{6})/g)].map(
      (match) => match[1] as string,
    )
    expect(colours.length).toBeGreaterThanOrEqual(8)
    for (const colour of new Set(colours)) {
      for (const background of ['#fbfaf8', '#f1efea']) {
        const ratio = contrast(colour, background)
        expect(ratio, `${colour} on ${background} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          WCAG_AA,
        )
      }
    }
  })
})
