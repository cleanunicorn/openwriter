import {
  chmodSync,
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
import { createTestApp, json, type TestApp } from '../test-helpers.ts'
import { WorkspaceList } from '../workspace-list.ts'

const SAMPLE = path.resolve(import.meta.dirname, '..', '..', '..', 'sample-workspace')
/** An absolute path a create request names; the server must never make it. */
const ANYWHERE = path.join(os.tmpdir(), `openwrite-anywhere-${process.pid}`)

let t: TestApp
let base: string
beforeEach(() => {
  t = createTestApp()
  base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-ws-'))
})
afterEach(() => {
  t.cleanup()
  rmSync(base, { recursive: true, force: true })
})

/**
 * Another workspace on disk, a copy of the sample, like the one the writer would switch to. It
 * lives in the server's workspaces folder, the only place the HTTP routes open by name.
 */
const another = (name: string, edit?: (root: string) => void): string => {
  const root = path.join(t.workspacesDir, name)
  mkdirSync(t.workspacesDir, { recursive: true })
  cpSync(SAMPLE, root, { recursive: true })
  edit?.(root)
  return root
}

/** Open a workspace in the workspaces folder by its name. */
const open = (root: string) => t.send('POST', '/api/workspaces/open', { name: path.basename(root) })

/** Switch to a remembered workspace by its id — the one way back to a root outside the folder. */
const switchBack = async (root: string) => {
  const { entries } = await json(t.get('/api/workspaces'))
  const entry = entries.find((candidate: { path: string }) => candidate.path === root)
  return t.send('POST', `/api/workspaces/${entry.id}/open`)
}

const create = (body: unknown) => t.send('POST', '/api/workspaces', body)

describe('the known-workspace list over HTTP', () => {
  it('lists the workspace the server started on as the active one', async () => {
    const listed = await json(t.get('/api/workspaces'))
    expect(listed.active.root).toBe(t.workspace)
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0].path).toBe(t.workspace)
  })

  it('renames an entry and deletes nothing', async () => {
    const { entries } = await json(t.get('/api/workspaces'))
    const res = await t.send('PATCH', `/api/workspaces/${entries[0].id}`, { label: 'My blog' })
    expect(res.status).toBe(200)
    expect((await json(res)).entries[0].label).toBe('My blog')
    expect((await json(t.get('/api/workspaces'))).active.label).toBe('My blog')
    expect(existsSync(path.join(t.workspace, 'strategy.md'))).toBe(true)
  })

  it('forgets an entry and deletes nothing', async () => {
    const second = another('second')
    expect((await open(second)).status).toBe(200)
    const { entries } = await json(t.get('/api/workspaces'))
    const first = entries.find((entry: { path: string }) => entry.path === t.workspace)
    const res = await t.send('DELETE', `/api/workspaces/${first.id}`)
    expect(res.status).toBe(200)
    expect((await json(res)).entries.map((entry: { path: string }) => entry.path)).toEqual([second])
    expect(existsSync(path.join(t.workspace, 'strategy.md'))).toBe(true)
  })

  it('refuses to rename or forget an entry it does not have', async () => {
    expect((await t.send('PATCH', '/api/workspaces/deadbeef0000', { label: 'x' })).status).toBe(404)
    expect((await t.send('DELETE', '/api/workspaces/deadbeef0000')).status).toBe(404)
  })
})

describe('opening another workspace', () => {
  it('serves the new root from every route that reads the workspace', async () => {
    const second = another('second', (root) => {
      rmSync(path.join(root, 'content', 'posts', 'hello-openwrite'), {
        recursive: true,
        force: true,
      })
      mkdirSync(path.join(root, 'content', 'posts', 'second-post'), { recursive: true })
      writeFileSync(
        path.join(root, 'content', 'posts', 'second-post', 'index.md'),
        '---\ntitle: "Second"\n---\n\n# Second\n',
      )
      writeFileSync(path.join(root, 'strategy.md'), 'the second strategy')
      writeFileSync(
        path.join(root, '.zen', 'config.json'),
        JSON.stringify({ concurrency: 5 }, null, 2),
      )
    })

    expect((await json(t.get('/api/articles'))).articles[0].slug).toBe('hello-openwrite')

    const res = await open(second)
    expect(res.status).toBe(200)
    expect((await json(res)).active.root).toBe(second)

    expect(
      (await json(t.get('/api/articles'))).articles.map((a: { slug: string }) => a.slug),
    ).toEqual(['second-post'])
    expect((await json(t.get('/api/docs/strategy'))).text).toBe('the second strategy')
    expect((await json(t.get('/api/config'))).config.concurrency).toBe(5)
    expect(await json(t.get('/api/jobs'))).toEqual({ jobs: [] })
    expect((await json(t.get('/api/health'))).workspace).toBe(path.basename(second))
  })

  it('remembers it, and switching back is the same door', async () => {
    const second = another('second')
    await open(second)
    expect((await json(t.get('/api/workspaces'))).entries).toHaveLength(2)
    expect((await switchBack(t.workspace)).status).toBe(200)
    const listed = await json(t.get('/api/workspaces'))
    expect(listed.active.root).toBe(t.workspace)
    expect(listed.entries).toHaveLength(2)
    expect((await json(t.get('/api/articles'))).articles[0].slug).toBe('hello-openwrite')
  })

  it('opening the workspace that is already open changes nothing', async () => {
    const res = await switchBack(t.workspace)
    expect(res.status).toBe(200)
    expect((await json(res)).active.root).toBe(t.workspace)
    expect((await json(t.get('/api/workspaces'))).entries).toHaveLength(1)
  })

  it('keeps guarding paths, now against the new root', async () => {
    const second = another('second')
    await open(second)
    // The old root's article is not reachable from the new one, and traversal is still refused.
    expect((await t.get('/api/docs/article/hello-openwrite')).status).toBe(200)
    expect((await json(t.get('/api/docs/article/hello-openwrite'))).text).toBe(
      readFileSync(path.join(second, 'content', 'posts', 'hello-openwrite', 'index.md'), 'utf8'),
    )
    expect((await t.get('/api/docs/article/..%2F..%2Fetc')).status).toBe(400)
  })

  it('refuses to switch to an id the list does not have', async () => {
    expect((await t.send('POST', '/api/workspaces/deadbeef0000/open')).status).toBe(404)
    expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
  })

  it.each([
    ['the filesystem root', { name: '/' }],
    ['an absolute path', { name: '/etc' }],
    ['a parent directory', { name: '..' }],
    ['a traversal', { name: '../escape' }],
    ['a nested path', { name: 'a/b' }],
    ['an empty name', { name: '' }],
    ['a name that is not there', { name: 'nope' }],
    ['a file', { name: 'a-file' }],
    ['a body that names a path of its own', { path: '/' }],
    ['a body that carries a path beside the name', { name: 'second', path: '/' }],
  ])('refuses %s', async (_name, request) => {
    another('second')
    writeFileSync(path.join(t.workspacesDir, 'a-file'), 'not a workspace')
    const res = await t.send('POST', '/api/workspaces/open', request)
    expect(res.status).toBe(400)
    expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
    expect((await json(t.get('/api/workspaces'))).entries).toHaveLength(1)
  })

  it('refuses a link in the workspaces folder that points outside it', async () => {
    const outside = path.join(base, 'outside')
    cpSync(SAMPLE, outside, { recursive: true })
    mkdirSync(t.workspacesDir, { recursive: true })
    symlinkSync(outside, path.join(t.workspacesDir, 'sneaky'))
    const res = await t.send('POST', '/api/workspaces/open', { name: 'sneaky' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('link')
    expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
  })

  it('refuses a directory it cannot read', async () => {
    mkdirSync(t.workspacesDir, { recursive: true })
    const locked = path.join(t.workspacesDir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect((await open(locked)).status).toBe(400)
      expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
    } finally {
      chmodSync(locked, 0o700)
    }
  })
})

describe('creating a workspace', () => {
  it('scaffolds it in the workspaces folder, remembers it, and opens it', async () => {
    const res = await create({ name: 'fresh', label: 'Fresh' })
    expect(res.status).toBe(201)
    const listed = await json(res)
    const root = path.join(t.workspacesDir, 'fresh')
    expect(listed.active.root).toBe(root)
    expect(listed.active.label).toBe('Fresh')
    expect(listed.home).toBe(t.workspacesDir)

    expect(existsSync(path.join(root, 'strategy.md'))).toBe(true)
    expect(existsSync(path.join(root, '.zen', 'config.json'))).toBe(true)
    expect(existsSync(path.join(root, 'content', 'posts'))).toBe(true)
    expect(existsSync(path.join(root, 'sources'))).toBe(true)
    expect(await json(t.get('/api/articles'))).toEqual({ articles: [] })
    expect((await json(t.get('/api/config'))).config.contentDir).toBe('content')
  })

  it('refuses a name that already has something in it, and writes nothing', async () => {
    const root = another('taken')
    const before = readFileSync(path.join(root, 'strategy.md'), 'utf8')
    const res = await create({ name: 'taken' })
    expect(res.status).toBe(400)
    expect(readFileSync(path.join(root, 'strategy.md'), 'utf8')).toBe(before)
    expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
  })

  // The reported hole: a path was scaffolded wherever the request said, `/` included. The table is
  // built before `beforeEach`, so the paths it names are fixed ones that must never appear.
  it.each([
    ['the filesystem root', { name: '/' }],
    ['an absolute path', { name: ANYWHERE }],
    ['a parent directory', { name: '..' }],
    ['a traversal', { name: '../escape' }],
    ['a nested path', { name: 'a/b' }],
    ['a hidden name', { name: '.zen' }],
    ['upper case', { name: 'Fresh' }],
    ['a name too long to be a folder', { name: 'a'.repeat(65) }],
    ['the old body, a path', { path: ANYWHERE }],
    ['a path beside the name', { name: 'fresh', path: '/' }],
  ])('refuses %s and creates nothing', async (_name, request) => {
    const res = await create(request)
    expect(res.status).toBe(400)
    expect(existsSync(ANYWHERE)).toBe(false)
    expect(existsSync(path.join(path.dirname(t.workspacesDir), 'escape'))).toBe(false)
    expect(existsSync(path.join(t.workspacesDir, 'fresh'))).toBe(false)
    expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
  })

  it('refuses a link planted at the name, and writes nothing where it points', async () => {
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    mkdirSync(t.workspacesDir, { recursive: true })
    symlinkSync(outside, path.join(t.workspacesDir, 'fresh'))
    const res = await create({ name: 'fresh' })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('link')
    expect(readdirSync(outside)).toEqual([])
    expect((await json(t.get('/api/workspaces'))).active.root).toBe(t.workspace)
  })
})

describe('deleting a workspace from disk', () => {
  /** Put a root in the list without opening it — the list is this test's own file. */
  const remember = (root: string, label: string): string => {
    const entry = new WorkspaceList(t.workspacesFile).touch(root, label)
    return entry.id
  }
  const erase = (id: string, confirm: string) =>
    t.send('POST', `/api/workspaces/${id}/erase`, { confirm })

  it('deletes the files and the entry once the writer types its name', async () => {
    const second = another('second')
    const id = remember(second, 'Second')
    const res = await erase(id, 'Second')
    expect(res.status).toBe(200)
    expect(existsSync(second)).toBe(false)
    expect((await json(res)).entries.map((entry: { id: string }) => entry.id)).not.toContain(id)
  })

  // AC12.1 — the confirmation is checked on the server too. The palette is where the writer
  // types it, but the client is not the trust boundary.
  it.each([
    ['the wrong name', 'second'],
    ['a near miss', 'Second '],
    ['something else entirely', 'yes'],
  ])('refuses %s and deletes nothing', async (_name, confirm) => {
    const second = another('second')
    const id = remember(second, 'Second')
    const res = await erase(id, confirm)
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('Second')
    expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
  })

  // AC12.2 — nothing outside the entry's own directory.
  it('unlinks a symlink that leaves the workspace instead of following it', async () => {
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    const second = another('second')
    symlinkSync(outside, path.join(second, 'sources', 'link-out'))

    const id = remember(second, 'Second')
    expect((await erase(id, 'Second')).status).toBe(200)

    expect(existsSync(second)).toBe(false)
    expect(existsSync(outside)).toBe(true)
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })

  it('refuses a recorded root that is itself a symlink', async () => {
    const real = another('real')
    const link = path.join(base, 'link')
    symlinkSync(real, link)
    const id = remember(link, 'Link')
    const res = await erase(id, 'Link')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('not a plain directory')
    expect(existsSync(real)).toBe(true)
    expect(existsSync(link)).toBe(true)
  })

  it('refuses a workspace whose contentDir points outside it, and says why', async () => {
    const hugo = path.join(base, 'hugo-site')
    mkdirSync(path.join(hugo, 'posts'), { recursive: true })
    writeFileSync(path.join(hugo, 'posts', 'real.md'), 'a real post')
    const second = another('second', (root) => {
      writeFileSync(
        path.join(root, '.zen', 'config.json'),
        JSON.stringify({ contentDir: hugo }, null, 2),
      )
    })
    const id = remember(second, 'Second')
    const res = await erase(id, 'Second')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('contentDir')
    expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
    expect(readFileSync(path.join(hugo, 'posts', 'real.md'), 'utf8')).toBe('a real post')
  })

  it('refuses a workspace whose contentDir cannot be used at all', async () => {
    const second = another('second', (root) => {
      writeFileSync(
        path.join(root, '.zen', 'config.json'),
        JSON.stringify({ contentDir: '../elsewhere' }, null, 2),
      )
    })
    const id = remember(second, 'Second')
    const res = await erase(id, 'Second')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('contentDir')
    expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
  })

  // AC12.3 — only a root the list owns. The request cannot name a path at all.
  it('refuses an id the list does not have', async () => {
    const second = another('second')
    const res = await erase('deadbeef0000', 'Second')
    expect(res.status).toBe(404)
    expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
  })

  it('refuses a body that tries to name a path of its own', async () => {
    const second = another('second')
    const id = remember(second, 'Second')
    const outside = path.join(base, 'outside')
    mkdirSync(outside)
    const res = await t.send('POST', `/api/workspaces/${id}/erase`, {
      confirm: 'Second',
      path: outside,
    })
    expect(res.status).toBe(400)
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(path.join(second, 'strategy.md'))).toBe(true)
  })

  // AC12.4 — never the open workspace, never the tracked sample.
  it('refuses the workspace that is open', async () => {
    const { entries } = await json(t.get('/api/workspaces'))
    const res = await erase(entries[0].id, entries[0].label)
    expect(res.status).toBe(409)
    expect(existsSync(path.join(t.workspace, 'strategy.md'))).toBe(true)
    expect((await json(t.get('/api/articles'))).articles).toHaveLength(1)
  })

  it('refuses the sample workspace this project ships', async () => {
    const id = remember(SAMPLE, 'sample-workspace')
    const res = await erase(id, 'sample-workspace')
    expect(res.status).toBe(400)
    expect((await json(res)).error).toContain('sample workspace')
    expect(existsSync(path.join(SAMPLE, 'strategy.md'))).toBe(true)
    expect(existsSync(path.join(SAMPLE, 'content', 'posts', 'hello-openwrite', 'index.md'))).toBe(
      true,
    )
  })

  it('drops the entry when its directory is already gone', async () => {
    const second = another('second')
    const id = remember(second, 'Second')
    rmSync(second, { recursive: true, force: true })
    const res = await erase(id, 'Second')
    expect(res.status).toBe(200)
    expect((await json(res)).entries.map((entry: { id: string }) => entry.id)).not.toContain(id)
  })
})
