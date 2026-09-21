/**
 * The global keyboard, as one pure decision so its precedence is unit-tested. App.tsx collects the
 * facts about the event and runs the action.
 *
 * Order: the palette key always works; a modal (Settings) owns everything else; a key another
 * control already handled is not ours; the panel keys work even while typing (they never move the
 * focus); the rest only when no text field has the keyboard.
 */

export type KeyAction =
  | 'palette'
  | 'toggle-left'
  | 'toggle-right'
  | 'undo'
  | 'redo'
  | 'enter-document'
  | null

export type KeyLike = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  defaultPrevented: boolean
  /**
   * AltGr is held. Windows reports it as Ctrl+Alt, and on many layouts AltGr+B types a character
   * (Hungarian: `{`); that keystroke is the writer's text, never a panel toggle.
   */
  altGraph: boolean
}

export type KeyContext = {
  modalOpen: boolean
  paletteOpen: boolean
  /** The target is an input, a textarea, a contenteditable, or a block editor. */
  inTextField: boolean
  /** The target is a control that Enter activates (a button, a link, a summary). */
  onControl: boolean
}

/** `Ctrl/Cmd+B` and `Ctrl/Cmd+Alt+B`; matched on `code`, because Option changes `key` on macOS. */
export const PANEL_KEYS = { left: 'Ctrl/Cmd+B', right: 'Ctrl/Cmd+Alt+B' } as const

export function routeKey(event: KeyLike, context: KeyContext): KeyAction {
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (mod && key === 'k') return 'palette'
  if (context.modalOpen) return null
  if (event.defaultPrevented) return null
  if (mod && !event.shiftKey && !event.altGraph && event.code === 'KeyB') {
    return event.altKey ? 'toggle-right' : 'toggle-left'
  }
  if (context.inTextField) return null
  if (mod && key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (mod && key === 'y') return 'redo'
  if (event.key === 'Enter' && !mod && !context.paletteOpen && !context.onControl) {
    return 'enter-document'
  }
  return null
}
