import type { UiState } from '../../shared/config-schema.ts'
import { saveConfigPatch, store } from '../state/app.ts'
import { createStore, useStoreSlice } from '../state/store.ts'
import { type PanelLayout, panelLayout } from './layout.ts'

/**
 * The shell's own state. Open/closed is persisted in config.json (`ui`); this store mirrors the
 * last value the app knew, so a workspace switch (config briefly `null`) does not flash the panels
 * shut. `leftDrawer` and `width` are per page session.
 */
export type ShellState = { ui: UiState; leftDrawer: boolean; width: number }

const shellStore = createStore<ShellState>({
  ui: { leftPanel: false, rightPanel: false },
  leftDrawer: false,
  width: typeof window === 'undefined' ? 0 : window.innerWidth,
})

store.subscribe(() => {
  const ui = store.get().config?.config.ui
  if (ui !== undefined && ui !== shellStore.get().ui) shellStore.set((state) => ({ ...state, ui }))
})

export const useShell = <T>(selector: (state: ShellState) => T): T =>
  useStoreSlice(shellStore, selector)

export const layoutOf = (state: ShellState): PanelLayout =>
  panelLayout(state.width, {
    left: state.ui.leftPanel,
    right: state.ui.rightPanel,
    leftDrawer: state.leftDrawer,
  })

export const currentLayout = (): PanelLayout => layoutOf(shellStore.get())

export const setShellWidth = (width: number) =>
  shellStore.set((state) => (state.width === width ? state : { ...state, width }))

const saveUi = (patch: Partial<UiState>) =>
  saveConfigPatch(
    { ui: { ...shellStore.get().ui, ...patch } },
    'The panel is open for now, but could not be remembered',
  )

/** Open or close the left panel as the writer sees it; opening by hand may overlay on a narrow window. */
export function toggleLeft(): void {
  const open = currentLayout().left !== 'closed'
  shellStore.set((state) => ({ ...state, leftDrawer: !open }))
  void saveUi({ leftPanel: !open })
}

export function setLeftOpen(open: boolean): void {
  if ((currentLayout().left !== 'closed') !== open) toggleLeft()
}

/** Open or close the right panel. Opening it never pushes the left one over the text. */
export function toggleRight(): void {
  setRightOpen(currentLayout().right === 'closed')
}

export function setRightOpen(open: boolean): void {
  if ((currentLayout().right !== 'closed') === open) return
  if (open) shellStore.set((state) => ({ ...state, leftDrawer: false }))
  void saveUi({ rightPanel: open })
}

/**
 * Give the keyboard to an element that mounts on a coming render: look for it for a few frames
 * rather than guessing when React commits.
 */
export function focusWhenMounted(find: () => HTMLElement | null, frames = 10): void {
  const attempt = () => {
    const element = find()
    if (element !== null) element.focus()
    else if (--frames > 0) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/** "Go to …": open the panel, bring it into view, and give its first control the keyboard. */
export function goToPanel(id: 'left-panel' | 'right-panel'): void {
  if (id === 'left-panel') setLeftOpen(true)
  else setRightOpen(true)
  focusWhenMounted(() => {
    const panel = document.getElementById(id)
    if (panel === null) return null
    panel.scrollIntoView({ block: 'nearest' })
    return (
      panel.querySelector<HTMLElement>(
        'button, a[href], input, textarea, select, summary, [tabindex="0"]',
      ) ?? panel
    )
  })
}
