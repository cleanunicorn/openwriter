import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COLUMN_GUTTERS,
  COLUMN_WIDTH,
  LEFT_PANEL_WIDTH,
  panelLayout,
  RIGHT_PANEL_WIDTH,
} from './layout.ts'

const closed = { left: false, right: false, leftDrawer: false }
// The thresholds, derived: the column (680 + its 96px of gutters) plus the panel(s) that dock.
const COLUMN = COLUMN_WIDTH + COLUMN_GUTTERS
const LEFT_DOCKS = COLUMN + LEFT_PANEL_WIDTH
const RIGHT_DOCKS = COLUMN + RIGHT_PANEL_WIDTH
const BOTH_DOCK = COLUMN + LEFT_PANEL_WIDTH + RIGHT_PANEL_WIDTH

describe('panelLayout', () => {
  it('keeps both panels closed when neither is open', () => {
    expect(panelLayout(2000, closed)).toEqual({ left: 'closed', right: 'closed' })
  })

  it('docks the left panel from its threshold, and not a pixel below', () => {
    const intent = { ...closed, left: true }
    expect(panelLayout(LEFT_DOCKS, intent).left).toBe('docked')
    expect(panelLayout(LEFT_DOCKS - 1, intent).left).toBe('closed')
    expect(panelLayout(LEFT_DOCKS - 1, { ...intent, leftDrawer: true }).left).toBe('overlay')
  })

  it('docks the right panel from its threshold and stacks it below that', () => {
    const intent = { ...closed, right: true }
    expect(panelLayout(RIGHT_DOCKS, intent).right).toBe('docked')
    expect(panelLayout(RIGHT_DOCKS - 1, intent).right).toBe('stacked')
    expect(panelLayout(390, intent).right).toBe('stacked')
  })

  it('docks both when both fit', () => {
    const intent = { left: true, right: true, leftDrawer: false }
    expect(panelLayout(BOTH_DOCK, intent)).toEqual({ left: 'docked', right: 'docked' })
  })

  it('gives the dock to the right panel when only one fits', () => {
    const intent = { left: true, right: true, leftDrawer: true }
    expect(panelLayout(BOTH_DOCK - 1, intent)).toEqual({ left: 'overlay', right: 'docked' })
    expect(panelLayout(RIGHT_DOCKS, intent)).toEqual({ left: 'overlay', right: 'docked' })
  })

  it('lets the left panel dock beside a stacked right panel', () => {
    const intent = { left: true, right: true, leftDrawer: false }
    expect(panelLayout(RIGHT_DOCKS - 1, intent)).toEqual({ left: 'docked', right: 'stacked' })
  })

  it('never restores a persisted left panel as an overlay covering the text', () => {
    expect(panelLayout(900, { left: true, right: false, leftDrawer: false }).left).toBe('closed')
  })

  it('works out the thresholds the docs and the e2e specs name', () => {
    expect([LEFT_DOCKS, RIGHT_DOCKS, BOTH_DOCK]).toEqual([1056, 1156, 1436])
  })
})

describe('layout.ts and theme.css agree', () => {
  // CSS places the panels; layout.ts decides when they fit. One number in two places must match.
  const css = readFileSync(path.join(import.meta.dirname, '..', 'theme.css'), 'utf8')
  const token = (name: string) => css.match(new RegExp(`--${name}:\\s*(\\d+)px`))?.[1]

  it('uses the same widths', () => {
    expect(Number(token('column'))).toBe(COLUMN_WIDTH)
    expect(Number(token('left-panel'))).toBe(LEFT_PANEL_WIDTH)
    expect(Number(token('right-panel'))).toBe(RIGHT_PANEL_WIDTH)
  })

  it('gives the column the same gutters', () => {
    expect(css).toContain(`--column-width: min(var(--column), 100% - ${COLUMN_GUTTERS}px);`)
    expect(css).toMatch(/\.column \{\s*width: var\(--column-width\)/)
  })

  it('moves the left handle at the same width the gutter reaches the edge', () => {
    expect(css).toContain(`@media (max-width: ${COLUMN_WIDTH + COLUMN_GUTTERS - 1}px)`)
  })
})
