import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The state modules hold the app's data; the features (shell, jobs UI, palette) build on them.
// An import the other way round lets a data change drive the screen from inside the store.
const dir = import.meta.dirname
const ALLOWED = /^(\.\/|\.\.\/api\.ts$|\.\.\/\.\.\/shared\/)/

describe('src/client/state', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    it(`${file} imports only state, api and shared modules`, () => {
      const source = readFileSync(path.join(dir, file), 'utf8')
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '')
      expect(imports.filter((spec) => !ALLOWED.test(spec) && spec.startsWith('.'))).toEqual([])
    })
  }
})
