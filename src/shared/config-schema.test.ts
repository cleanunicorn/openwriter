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
