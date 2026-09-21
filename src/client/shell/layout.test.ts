import { describe, expect, it } from 'vitest'
import { panelLayout } from './layout.ts'

const closed = { left: false, right: false, leftDrawer: false }

describe('panelLayout', () => {
  it('keeps both panels closed when neither is open', () => {
    expect(panelLayout(2000, closed)).toEqual({ left: 'closed', right: 'closed' })
  })

  it('docks the left panel from 1056px, and not a pixel below', () => {
    const intent = { ...closed, left: true }
    expect(panelLayout(1056, intent).left).toBe('docked')
    expect(panelLayout(1055, intent).left).toBe('closed')
    expect(panelLayout(1055, { ...intent, leftDrawer: true }).left).toBe('overlay')
  })

  it('docks the right panel from 1156px and stacks it below that', () => {
    const intent = { ...closed, right: true }
    expect(panelLayout(1156, intent).right).toBe('docked')
    expect(panelLayout(1155, intent).right).toBe('stacked')
    expect(panelLayout(390, intent).right).toBe('stacked')
  })

  it('docks both from 1436px', () => {
    const intent = { left: true, right: true, leftDrawer: false }
    expect(panelLayout(1436, intent)).toEqual({ left: 'docked', right: 'docked' })
  })

  it('gives the dock to the right panel when only one fits', () => {
    const intent = { left: true, right: true, leftDrawer: true }
    expect(panelLayout(1435, intent)).toEqual({ left: 'overlay', right: 'docked' })
    expect(panelLayout(1156, intent)).toEqual({ left: 'overlay', right: 'docked' })
  })

  it('lets the left panel dock beside a stacked right panel', () => {
    const intent = { left: true, right: true, leftDrawer: false }
    expect(panelLayout(1100, intent)).toEqual({ left: 'docked', right: 'stacked' })
  })

  it('never restores a persisted left panel as an overlay covering the text', () => {
    expect(panelLayout(900, { left: true, right: false, leftDrawer: false }).left).toBe('closed')
  })
})
