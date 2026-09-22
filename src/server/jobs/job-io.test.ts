import { execFileSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
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
import { PathEscapeError } from '../paths.ts'
import {
  appendJobText,
  readJobAsset,
  readJobText,
  readJobTextOrNull,
  removeJobDir,
  UnsafeJobFileError,
  writeJobText,
} from './job-io.ts'

let base: string
let jobDir: string
let outside: string
const secret = () => path.join(outside, 'secret.txt')

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'openwrite-jobio-'))
  jobDir = path.join(base, 'ws', '.zen', 'jobs', 'j1')
  outside = path.join(base, 'outside')
  mkdirSync(path.join(jobDir, 'assets'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(secret(), 'TOP SECRET\n')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('reading an artifact', () => {
  it('reads a plain file and reports a missing one as null', () => {
    writeFileSync(path.join(jobDir, 'result.json'), '{"summary":"ok"}')
    expect(readJobText(jobDir, 'result.json')).toBe('{"summary":"ok"}')
    expect(readJobText(jobDir, 'nope.json')).toBeNull()
  })

  it.each([
    ['a symlink to an outside file', () => symlinkSync(secret(), path.join(jobDir, 'result.json'))],
    ['a hard link to an outside file', () => linkSync(secret(), path.join(jobDir, 'result.json'))],
    ['a directory', () => mkdirSync(path.join(jobDir, 'result.json'))],
    [
      'a FIFO (must not block the server)',
      () => execFileSync('mkfifo', [path.join(jobDir, 'result.json')]),
    ],
  ])('refuses %s', (_name, plant) => {
    plant()
    expect(() => readJobText(jobDir, 'result.json')).toThrow(UnsafeJobFileError)
    expect(readJobTextOrNull(jobDir, 'result.json')).toBeNull()
  })

  it('accepts only plain artifact names', () => {
    expect(() => readJobText(jobDir, '../../../outside/secret.txt')).toThrow(PathEscapeError)
    expect(() => readJobText(jobDir, 'assets/x')).toThrow(PathEscapeError)
  })
})

describe('writing an artifact', () => {
  it.each([
    ['a symlink', (name: string) => symlinkSync(secret(), path.join(jobDir, name))],
    ['a hard link', (name: string) => linkSync(secret(), path.join(jobDir, name))],
  ])('replaces %s instead of writing through it', (_name, plant) => {
    for (const name of ['repair.md', 'result.invalid.json', 'job.json']) {
      plant(name)
      writeJobText(jobDir, name, 'server text')
      expect(readFileSync(path.join(jobDir, name), 'utf8')).toBe('server text')
    }
    expect(readFileSync(secret(), 'utf8')).toBe('TOP SECRET\n')
    // No temp file is left behind, and its name is not predictable.
    expect(readdirSync(jobDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('appends to a plain log and leaves a linked one alone', () => {
    expect(appendJobText(jobDir, 'progress.log', 'one\n')).toBe(true)
    expect(appendJobText(jobDir, 'progress.log', 'two\n')).toBe(true)
    expect(readFileSync(path.join(jobDir, 'progress.log'), 'utf8')).toBe('one\ntwo\n')

    rmSync(path.join(jobDir, 'progress.log'))
    symlinkSync(secret(), path.join(jobDir, 'progress.log'))
    expect(appendJobText(jobDir, 'progress.log', 'leak\n')).toBe(false)
    rmSync(path.join(jobDir, 'progress.log'))
    linkSync(secret(), path.join(jobDir, 'progress.log'))
    expect(appendJobText(jobDir, 'progress.log', 'leak\n')).toBe(false)
    expect(readFileSync(secret(), 'utf8')).toBe('TOP SECRET\n')
  })
})

describe('job assets', () => {
  it('reads a plain asset, nested paths included', () => {
    mkdirSync(path.join(jobDir, 'assets', 'img'))
    writeFileSync(path.join(jobDir, 'assets', 'img', 'a.png'), 'png')
    expect(readJobAsset(jobDir, 'assets/img/a.png')?.toString()).toBe('png')
    expect(readJobAsset(jobDir, 'assets/missing.png')).toBeNull()
    expect(readJobAsset(jobDir, 'assets/')).toBeNull()
  })

  it('treats a symlinked assets directory as an escape, not as a new root', () => {
    rmSync(path.join(jobDir, 'assets'), { recursive: true })
    symlinkSync(outside, path.join(jobDir, 'assets'))
    expect(() => readJobAsset(jobDir, 'assets/secret.txt')).toThrow(PathEscapeError)
  })

  it('refuses a symlinked directory below assets, and a linked file', () => {
    symlinkSync(outside, path.join(jobDir, 'assets', 'dir'))
    expect(() => readJobAsset(jobDir, 'assets/dir/secret.txt')).toThrow(PathEscapeError)
    symlinkSync(secret(), path.join(jobDir, 'assets', 'soft.txt'))
    expect(() => readJobAsset(jobDir, 'assets/soft.txt')).toThrow(PathEscapeError)
    linkSync(secret(), path.join(jobDir, 'assets', 'hard.txt'))
    expect(readJobAsset(jobDir, 'assets/hard.txt')).toBeNull()
  })
})

describe('removing a job directory', () => {
  const ID = '20260922-101500-ab12'
  let jobsDir: string
  let victim: string
  beforeEach(() => {
    jobsDir = path.join(base, 'ws', '.zen', 'jobs')
    victim = path.join(jobsDir, ID)
    mkdirSync(path.join(victim, 'assets', 'deep'), { recursive: true })
    writeFileSync(path.join(victim, 'job.json'), '{}')
    writeFileSync(path.join(victim, 'assets', 'deep', 'a.png'), 'png')
  })

  it('removes the whole tree and nothing beside it', () => {
    removeJobDir(jobsDir, ID)
    expect(existsSync(victim)).toBe(false)
    // The job directory the other tests use sits beside it and is untouched.
    expect(existsSync(jobDir)).toBe(true)
  })

  it('unlinks every agent-planted link without touching what it points at', () => {
    symlinkSync(secret(), path.join(victim, 'result.json'))
    symlinkSync(outside, path.join(victim, 'assets', 'escape'))
    linkSync(secret(), path.join(victim, 'assets', 'hard.txt'))
    execFileSync('mkfifo', [path.join(victim, 'progress.log')])
    removeJobDir(jobsDir, ID)
    expect(existsSync(victim)).toBe(false)
    expect(readFileSync(secret(), 'utf8')).toBe('TOP SECRET\n')
    expect(readdirSync(outside)).toEqual(['secret.txt'])
  })

  it('refuses a job directory that is a symlink, and leaves its target alone', () => {
    rmSync(victim, { recursive: true })
    symlinkSync(outside, victim)
    expect(() => removeJobDir(jobsDir, ID)).toThrow(UnsafeJobFileError)
    expect(readFileSync(secret(), 'utf8')).toBe('TOP SECRET\n')
  })

  it('refuses a file where a job directory should be', () => {
    rmSync(victim, { recursive: true })
    writeFileSync(victim, 'not a dir')
    expect(() => removeJobDir(jobsDir, ID)).toThrow(UnsafeJobFileError)
    expect(existsSync(victim)).toBe(true)
  })

  it('refuses a jobs directory that is a symlink', () => {
    const linked = path.join(base, 'linked-jobs')
    symlinkSync(jobsDir, linked)
    expect(() => removeJobDir(linked, ID)).toThrow(UnsafeJobFileError)
    expect(existsSync(victim)).toBe(true)
  })

  it.each(['..', '.', '', 'j1', `../${ID}`, `${ID}/assets`, '20260922-101500-AB12'])(
    'removes only names that are job ids: refuses %j',
    (name) => {
      expect(() => removeJobDir(jobsDir, name)).toThrow(PathEscapeError)
      expect(existsSync(victim)).toBe(true)
      expect(existsSync(jobDir)).toBe(true)
    },
  )
})
