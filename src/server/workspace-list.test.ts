import {
  chmodSync,
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
import { createApp } from './app.ts'
import { createTestApp } from './test-helpers.ts'
import { realpathOrSelf, WorkspaceList } from './workspace-list.ts'

let base: string
let file: string
let list: WorkspaceList

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-list-'))
  file = path.join(base, 'config', 'openwrite', 'workspaces.json')
  list = new WorkspaceList(file)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const dir = (name: string): string => {
  const created = path.join(base, name)
  mkdirSync(created, { recursive: true })
  return created
}

const write = (text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

describe('the known-workspace list degrades instead of failing', () => {
  it('reads an empty list when the file does not exist', () => {
    expect(existsSync(file)).toBe(false)
    expect(list.entries()).toEqual([])
  })

  it('reads an empty list when the file is not valid JSON', () => {
    write('{ not json')
    expect(list.entries()).toEqual([])
  })

  it('reads an empty list when the file does not match the schema', () => {
    write(JSON.stringify({ version: 1, entries: [{ id: 'nope', path: 42 }] }))
    expect(list.entries()).toEqual([])
  })

  it('reads an empty list when the file cannot be read', () => {
    write(JSON.stringify({ version: 1, entries: [] }))
    chmodSync(file, 0o000)
    try {
      expect(list.entries()).toEqual([])
    } finally {
      chmodSync(file, 0o600)
    }
  })

  it('keeps a valid file, and defaults a partial one', () => {
    const entry = list.touch(dir('a'), 'A')
    expect(list.entries()).toEqual([entry])
    write(JSON.stringify({ entries: [entry] }))
    expect(list.entries()).toEqual([entry])
  })
})

describe('the known-workspace list is written atomically', () => {
  it('creates the directory and leaves no temp file behind', () => {
    list.touch(dir('a'), 'A')
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
    expect(readdirSync(path.dirname(file))).toEqual(['workspaces.json'])
  })

  it('never leaves a half-written file where a reader could see one', () => {
    list.touch(dir('a'), 'A')
    const temp = `${file}.${process.pid}.tmp`
    expect(existsSync(temp)).toBe(false)
  })
})

describe('entries', () => {
  it('labels a new entry with the directory name and gives it a 12-hex id', () => {
    const entry = list.touch(dir('my-blog'))
    expect(entry.label).toBe('my-blog')
    expect(entry.id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('refreshes rather than duplicates a root it already knows', () => {
    const first = list.touch(dir('a'), 'A')
    const again = list.touch(path.join(base, 'a'))
    expect(again.id).toBe(first.id)
    expect(again.label).toBe('A')
    expect(list.entries()).toHaveLength(1)
  })

  it('treats the same root reached through a symlink as one workspace', () => {
    const real = dir('a')
    const link = path.join(base, 'a-link')
    symlinkSync(real, link)
    const first = list.touch(real, 'A')
    const second = list.touch(link, 'A again')
    expect(second.id).toBe(first.id)
    expect(list.entries()).toHaveLength(1)
  })

  it('finds an entry by id and by path', () => {
    const entry = list.touch(dir('a'), 'A')
    expect(list.find(entry.id)).toEqual(entry)
    expect(list.findByPath(path.join(base, 'a'))).toEqual(entry)
    expect(list.find('000000000000')).toBeUndefined()
    expect(list.findByPath(path.join(base, 'nope'))).toBeUndefined()
  })
})

describe('rename and forget change the list only', () => {
  it('renames the label and leaves every file in the workspace untouched', () => {
    const root = dir('a')
    writeFileSync(path.join(root, 'strategy.md'), 'mine')
    const entry = list.touch(root, 'A')
    const renamed = list.rename(entry.id, 'Still mine')
    expect(renamed?.label).toBe('Still mine')
    expect(renamed?.path).toBe(root)
    expect(existsSync(root)).toBe(true)
    expect(readFileSync(path.join(root, 'strategy.md'), 'utf8')).toBe('mine')
  })

  it('forgets an entry and leaves every file in the workspace untouched', () => {
    const root = dir('a')
    writeFileSync(path.join(root, 'strategy.md'), 'mine')
    const entry = list.touch(root, 'A')
    expect(list.forget(entry.id)).toBe(true)
    expect(list.entries()).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(readFileSync(path.join(root, 'strategy.md'), 'utf8')).toBe('mine')
  })

  it('reports an unknown id rather than changing anything', () => {
    const entry = list.touch(dir('a'), 'A')
    expect(list.rename('000000000000', 'x')).toBeUndefined()
    expect(list.forget('000000000000')).toBe(false)
    expect(list.entries()).toEqual([entry])
  })
})

describe('the workspace the server started on', () => {
  it('is remembered, so the palette is never empty on a first run', () => {
    const t = createTestApp()
    try {
      const entries = new WorkspaceList(t.workspacesFile).entries()
      expect(entries).toHaveLength(1)
      expect(realpathOrSelf(entries[0]?.path ?? '')).toBe(realpathOrSelf(t.workspace))
      expect(entries[0]?.label).toBe(path.basename(t.workspace))
    } finally {
      t.cleanup()
    }
  })

  it('is remembered once, however many times the server restarts on it', () => {
    const t = createTestApp()
    try {
      const again = createApp({
        workspace: t.workspace,
        workspacesFile: t.workspacesFile,
        fakeControl: false,
        allowedHosts: () => [],
      })
      try {
        expect(new WorkspaceList(t.workspacesFile).entries()).toHaveLength(1)
      } finally {
        void again.dispose()
      }
    } finally {
      t.cleanup()
    }
  })
})
