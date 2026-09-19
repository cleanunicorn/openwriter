import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isStale } from './ensure-build.ts'

let dir: string
let output: string
let sources: string
const at = (file: string, secondsAgo: number) => {
  const time = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(file, time, time)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'openwrite-build-'))
  sources = path.join(dir, 'src')
  output = path.join(dir, 'index.html')
  mkdirSync(path.join(sources, 'nested'), { recursive: true })
  for (const file of ['a.ts', 'nested/b.ts']) {
    writeFileSync(path.join(sources, file), 'x')
    at(path.join(sources, file), 100)
  }
  at(path.join(sources, 'nested'), 100)
  at(sources, 100)
  writeFileSync(output, 'built')
  at(output, 50)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('isStale', () => {
  it('is fresh when the output is newer than every source', () => {
    expect(isStale(output, [sources])).toBe(false)
  })

  it('is stale without an output, and after a source edit', () => {
    writeFileSync(path.join(sources, 'nested', 'b.ts'), 'edited')
    expect(isStale(output, [sources])).toBe(true)
    expect(isStale(path.join(dir, 'missing.html'), [sources])).toBe(true)
  })

  it('is stale after a source file was deleted or renamed', () => {
    rmSync(path.join(sources, 'nested', 'b.ts'))
    expect(isStale(output, [sources])).toBe(true)
    at(path.join(sources, 'nested'), 100)
    expect(isStale(output, [sources])).toBe(false)
    renameSync(path.join(sources, 'a.ts'), path.join(sources, 'renamed.ts'))
    expect(isStale(output, [sources])).toBe(true)
  })
})
