import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from './config-schema.ts'

describe('config ui state', () => {
  it('starts with both panels closed', () => {
    expect(DEFAULT_CONFIG.ui).toEqual({ leftPanel: false, rightPanel: false })
  })

  it('loads a file written before the panels existed', () => {
    const config = ConfigSchema.parse({ theme: 'dark', concurrency: 2 })
    expect(config.ui).toEqual({ leftPanel: false, rightPanel: false })
    expect(config.theme).toBe('dark')
  })

  it('fills a partial ui object with the defaults', () => {
    expect(ConfigSchema.parse({ ui: { rightPanel: true } }).ui).toEqual({
      leftPanel: false,
      rightPanel: true,
    })
  })

  it('rejects a ui value that is not a boolean', () => {
    expect(ConfigSchema.safeParse({ ui: { leftPanel: 'yes' } }).success).toBe(false)
  })
})

describe('README documents every config key', () => {
  it('has a row for each top-level key of .zen/config.json', () => {
    const readme = readFileSync(path.join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
    // `version` is the file format's own marker, not a setting.
    const keys = Object.keys(ConfigSchema.shape).filter((key) => key !== 'version')
    for (const key of keys) expect(readme).toMatch(new RegExp(`^\\| \`${key}[.\`]`, 'm'))
  })
})
