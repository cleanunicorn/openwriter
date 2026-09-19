import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertSlug, PathEscapeError, resolveWithin } from './paths.ts'

const base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-paths-'))
const root = path.join(base, 'ws')
const sibling = path.join(base, 'ws-evil')
mkdirSync(path.join(root, 'content', 'posts'), { recursive: true })
mkdirSync(sibling)
writeFileSync(path.join(sibling, 'secret.txt'), 'secret')
symlinkSync(sibling, path.join(root, 'link-out'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('resolveWithin', () => {
  it('resolves a nested path inside the root', () => {
    expect(resolveWithin(root, 'content', 'posts', 'a', 'index.md')).toBe(
      path.join(root, 'content', 'posts', 'a', 'index.md'),
    )
  })

  it.each([
    ['parent traversal', ['..', 'ws-evil', 'secret.txt']],
    ['nested traversal', ['content', '../../ws-evil/secret.txt']],
    ['percent-encoded traversal', ['..%2fws-evil%2fsecret.txt']],
    ['encoded dots', ['%2e%2e/ws-evil/secret.txt']],
    ['backslash traversal', ['content\\..\\..\\ws-evil']],
    ['absolute path', ['/etc/passwd']],
    ['NUL byte', ['content\0.md']],
    ['malformed encoding', ['%E0%A4%A']],
  ])('rejects %s', (_name, segments) => {
    expect(() => resolveWithin(root, ...segments)).toThrow(PathEscapeError)
  })

  it('rejects a sibling directory that shares the root prefix', () => {
    expect(() => resolveWithin(root, '../ws-evil')).toThrow(PathEscapeError)
  })

  it('rejects an existing path behind a symlink that leaves the root', () => {
    expect(() => resolveWithin(root, 'link-out', 'secret.txt')).toThrow(PathEscapeError)
  })

  it('rejects creating a new file under a symlinked ancestor', () => {
    expect(() => resolveWithin(root, 'link-out', 'new', 'file.png')).toThrow(PathEscapeError)
  })

  it('allows a path that does not exist yet', () => {
    expect(resolveWithin(root, 'content', 'posts', 'new-post', 'index.md')).toContain('new-post')
  })
})

describe('assertSlug', () => {
  it('accepts kebab-case', () => {
    expect(assertSlug('hello-openwrite')).toBe('hello-openwrite')
  })
  it.each(['', '../x', 'Upper', '-lead', 'a/b', 'a b', 'a.b'])('rejects %j', (slug) => {
    expect(() => assertSlug(slug)).toThrow(PathEscapeError)
  })
})
