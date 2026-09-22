import { describe, expect, it } from 'vitest'
import { type KeyContext, type KeyLike, routeKey } from './keys.ts'

const key = (overrides: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  altGraph: false,
  ...overrides,
})
const idle: KeyContext = {
  modalOpen: false,
  paletteOpen: false,
  inTextField: false,
  onControl: false,
}

const modB = key({ key: 'b', code: 'KeyB', ctrlKey: true })
const modAltB = key({ key: '∫', code: 'KeyB', metaKey: true, altKey: true })

describe('routeKey', () => {
  it('opens the palette from anywhere, even behind a modal', () => {
    expect(routeKey(key({ key: 'k', ctrlKey: true }), { ...idle, modalOpen: true })).toBe('palette')
    expect(routeKey(key({ key: 'K', metaKey: true }), { ...idle, inTextField: true })).toBe(
      'palette',
    )
  })

  it('toggles the panels, also while typing, matched on the physical key', () => {
    expect(routeKey(modB, idle)).toBe('toggle-left')
    expect(routeKey(modB, { ...idle, inTextField: true })).toBe('toggle-left')
    expect(routeKey(modAltB, idle)).toBe('toggle-right')
    expect(routeKey(modAltB, { ...idle, inTextField: true })).toBe('toggle-right')
  })

  it('leaves AltGr+B alone: on Windows it arrives as Ctrl+Alt, and it types a character', () => {
    const altGr = key({ key: '{', code: 'KeyB', ctrlKey: true, altKey: true, altGraph: true })
    expect(routeKey(altGr, idle)).toBeNull()
    expect(routeKey(altGr, { ...idle, inTextField: true })).toBeNull()
  })

  it('leaves Ctrl/Cmd+Shift+B and a bare B alone', () => {
    expect(routeKey({ ...modB, shiftKey: true }, idle)).toBeNull()
    expect(routeKey(key({ key: 'b', code: 'KeyB' }), idle)).toBeNull()
  })

  it('lets a modal own every other key', () => {
    expect(routeKey(modB, { ...idle, modalOpen: true })).toBeNull()
    expect(routeKey(key({ key: 'z', ctrlKey: true }), { ...idle, modalOpen: true })).toBeNull()
    expect(routeKey(key({ key: 'Enter' }), { ...idle, modalOpen: true })).toBeNull()
  })

  it('ignores a key another control already handled', () => {
    expect(routeKey({ ...modB, defaultPrevented: true }, idle)).toBeNull()
    expect(routeKey(key({ key: 'Enter', defaultPrevented: true }), idle)).toBeNull()
  })

  it('undoes and redoes the document only outside a text field', () => {
    expect(routeKey(key({ key: 'z', ctrlKey: true }), idle)).toBe('undo')
    expect(routeKey(key({ key: 'Z', ctrlKey: true, shiftKey: true }), idle)).toBe('redo')
    expect(routeKey(key({ key: 'y', metaKey: true }), idle)).toBe('redo')
    expect(routeKey(key({ key: 'z', ctrlKey: true }), { ...idle, inTextField: true })).toBeNull()
  })

  it('enters the document on a bare Enter, but not on a button or with the palette open', () => {
    expect(routeKey(key({ key: 'Enter' }), idle)).toBe('enter-document')
    expect(routeKey(key({ key: 'Enter' }), { ...idle, onControl: true })).toBeNull()
    expect(routeKey(key({ key: 'Enter' }), { ...idle, paletteOpen: true })).toBeNull()
    expect(routeKey(key({ key: 'Enter', ctrlKey: true }), idle)).toBeNull()
    expect(routeKey(key({ key: 'Enter' }), { ...idle, inTextField: true })).toBeNull()
  })
})
