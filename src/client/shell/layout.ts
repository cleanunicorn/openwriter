/**
 * Where the edge panels go at a given window width. Pure, so every threshold is unit-tested.
 *
 * A panel docks (reserves its width beside the column) only when the column still gets its full
 * 680px plus the 48px gutters that hold the drag handle; the column never shrinks. When both
 * cannot dock, the right panel keeps the dock: research answers arrive there unasked and must
 * never cover the text. Below its width the right panel stacks after the article (research's
 * behaviour before the panels existed), and the left panel becomes an overlay drawer — but only
 * after the writer opened it by hand in this page session (`leftDrawer`), so a reload in a narrow
 * window never comes back with the text covered.
 */

export const COLUMN_WIDTH = 680
/** The two 48px gutters around the column (`.column`: `100% - 96px`). */
export const COLUMN_GUTTERS = 96
export const LEFT_PANEL_WIDTH = 280
export const RIGHT_PANEL_WIDTH = 380

const COLUMN_NEEDS = COLUMN_WIDTH + COLUMN_GUTTERS

export type PanelIntent = {
  left: boolean
  right: boolean
  /** The writer opened the left panel by hand in this page session. */
  leftDrawer: boolean
}

export type PanelLayout = {
  left: 'closed' | 'docked' | 'overlay'
  right: 'closed' | 'docked' | 'stacked'
}

export function panelLayout(viewportWidth: number, intent: PanelIntent): PanelLayout {
  const rightDocks = intent.right && viewportWidth >= COLUMN_NEEDS + RIGHT_PANEL_WIDTH
  const right = !intent.right ? 'closed' : rightDocks ? 'docked' : 'stacked'
  if (!intent.left) return { left: 'closed', right }
  const leftNeeds = COLUMN_NEEDS + LEFT_PANEL_WIDTH + (rightDocks ? RIGHT_PANEL_WIDTH : 0)
  if (viewportWidth >= leftNeeds) return { left: 'docked', right }
  return { left: intent.leftDrawer ? 'overlay' : 'closed', right }
}
