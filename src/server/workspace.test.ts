import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathEscapeError } from './paths.ts'
import { Workspace } from './workspace.ts'

const SAMPLE = path.resolve(import.meta.dirname, '..', '..', 'sample-workspace')

let base: string
let first: string
let second: string

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-retarget-'))
  first = path.join(base, 'one')
  second = path.join(base, 'two')
  cpSync(SAMPLE, first, { recursive: true })
  cpSync(SAMPLE, second, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('a workspace can be pointed at another root', () => {
  it('resolves every path against the new root afterwards', () => {
    const workspace = new Workspace(first)
    workspace.retarget(second)
    expect(workspace.root).toBe(second)
    expect(workspace.strategyPath()).toBe(path.join(second, 'strategy.md'))
    expect(workspace.jobsDir()).toBe(path.join(second, '.zen', 'jobs'))
    expect(workspace.contentRoot()).toBe(path.join(second, 'content'))
    expect(workspace.briefPath('hello-openwrite')).toBe(
      path.join(second, '.zen', 'articles', 'hello-openwrite', 'brief.md'),
    )
    expect(workspace.docPath({ kind: 'article', slug: 'hello-openwrite' })).toBe(
      path.join(second, 'content', 'posts', 'hello-openwrite', 'index.md'),
    )
  })

  it('reads and writes the new root, and leaves the old one alone', () => {
    const workspace = new Workspace(first)
    const strategy = workspace.readDoc({ kind: 'strategy' })
    workspace.retarget(second)
    workspace.writeDoc({ kind: 'strategy' }, 'only in the second', strategy.hash)
    expect(workspace.readDoc({ kind: 'strategy' }).text).toBe('only in the second')
    expect(new Workspace(first).readDoc({ kind: 'strategy' }).text).toBe(strategy.text)
  })

  it('still refuses to leave the root — the new one', () => {
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, path.join(second, 'content', 'posts', 'escape'))
    const workspace = new Workspace(first)
    workspace.retarget(second)
    expect(() => workspace.docPath({ kind: 'article', slug: '../../../outside' })).toThrow(
      PathEscapeError,
    )
    expect(() => workspace.bundleDir('escape')).toThrow(PathEscapeError)
  })

  it('takes the new root’s settings, not the old root’s', () => {
    writeFileSync(
      path.join(second, '.zen', 'config.json'),
      JSON.stringify({ concurrency: 7 }, null, 2),
    )
    const workspace = new Workspace(first)
    expect(workspace.config().config.concurrency).toBe(3)
    workspace.retarget(second)
    expect(workspace.config().config.concurrency).toBe(7)
  })

  it('lists the new root’s articles', () => {
    rmSync(path.join(second, 'content', 'posts', 'hello-openwrite'), {
      recursive: true,
      force: true,
    })
    const workspace = new Workspace(first)
    expect(workspace.listArticles().map((article) => article.slug)).toEqual(['hello-openwrite'])
    workspace.retarget(second)
    expect(workspace.listArticles()).toEqual([])
  })
})
