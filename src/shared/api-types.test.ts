import { describe, expect, it } from 'vitest'
import { decodeWorkspaceHeader, encodeWorkspaceHeader, WORKSPACE_HEADER } from './api-types.ts'

describe('the workspace header', () => {
  const roots = ['/tmp/ascii', '/home/me/ț-drafts', '/home/me/文章', '/tmp/📝 notes']

  it('carries any workspace path through a real fetch Headers, and back', () => {
    for (const root of roots) {
      const headers = new Headers({ [WORKSPACE_HEADER]: encodeWorkspaceHeader(root) })
      expect(decodeWorkspaceHeader(headers.get(WORKSPACE_HEADER) ?? '')).toBe(root)
    }
  })

  it('is needed: a raw path above U+00FF is not a valid header value', () => {
    expect(() => new Headers({ [WORKSPACE_HEADER]: '/home/me/文章' })).toThrow()
  })

  it('names no workspace when it does not decode', () => {
    expect(decodeWorkspaceHeader('%E0%A4%A')).toBeNull()
  })
})
