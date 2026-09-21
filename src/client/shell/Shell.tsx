import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react'
import { PANEL_KEYS } from './keys.ts'
import { layoutOf, setLeftOpen, setShellWidth, toggleLeft, toggleRight, useShell } from './state.ts'

/** A click must never take the keyboard from an open block (blur commits it). */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()

function EdgeHandle({
  side,
  label,
  open,
  onToggle,
}: {
  side: 'left' | 'right'
  label: string
  open: boolean
  onToggle: () => void
}) {
  // Points the way the panel will move: out when closed, back in when open.
  const glyph = (side === 'left') === open ? '‹' : '›'
  return (
    <button
      type="button"
      className={`edge-handle edge-handle-${side}`}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? `${side}-panel` : undefined}
      title={`${open ? 'Hide' : 'Show'} ${label.toLowerCase()} (${PANEL_KEYS[side]})`}
      onMouseDown={keepFocus}
      onClick={onToggle}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

/**
 * Escape inside a panel hands the keyboard back to where it was before it entered the panel (or
 * lets go of it); an overlay drawer also closes. A docked panel stays open: closing it is the
 * toggle's job. A key something inside already handled (a palette prompt, a pill) is left alone.
 */
function usePanelKeyboard(onEscape?: () => void) {
  const cameFrom = useRef<HTMLElement | null>(null)
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const from = event.relatedTarget
    if (from instanceof HTMLElement && !event.currentTarget.contains(from)) cameFrom.current = from
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    const back = cameFrom.current
    cameFrom.current = null
    if (back?.isConnected) back.focus()
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onEscape?.()
  }
  return { onFocus, onKeyDown }
}

/**
 * The frame around the writing column: two edge panels, closed on first run and opened only on
 * purpose (a handle or Ctrl/Cmd+B, Ctrl/Cmd+Alt+B). Closed panels are not mounted at all. The
 * shell owns placement; what is inside a panel knows nothing about where it is shown.
 */
export function Shell({
  children,
  left,
  right,
}: {
  children: ReactNode
  left: ReactNode
  right: ReactNode
}) {
  // Two primitives, not one object: a store selector must return a stable value.
  const layout = {
    left: useShell((state) => layoutOf(state).left),
    right: useShell((state) => layoutOf(state).right),
  }

  const leftKeys = usePanelKeyboard(() => {
    if (layout.left === 'overlay') setLeftOpen(false)
  })
  const rightKeys = usePanelKeyboard()

  // A drawer over the page closes when the writer clicks anywhere else. The handles are not
  // "elsewhere": they toggle their own panel, and closing the right one may let the left dock.
  useEffect(() => {
    if (layout.left !== 'overlay') return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('#left-panel, .edge-handle, .palette-backdrop') !== null) return
      setLeftOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [layout.left])

  useEffect(() => {
    const onResize = () => setShellWidth(window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The column is placed by CSS from these: a docked panel reserves its width beside it.
  useEffect(() => {
    document.body.dataset.left = layout.left
    document.body.dataset.right = layout.right
  }, [layout.left, layout.right])

  return (
    <>
      <EdgeHandle
        side="left"
        label="Files and actions"
        open={layout.left !== 'closed'}
        onToggle={toggleLeft}
      />
      {layout.left !== 'closed' && (
        <nav
          id="left-panel"
          className="shell-panel shell-left"
          data-layout={layout.left}
          aria-label="Files and actions"
          tabIndex={-1}
          {...leftKeys}
        >
          {left}
        </nav>
      )}
      {children}
      {layout.right !== 'closed' && (
        <section
          id="right-panel"
          className="shell-panel shell-right"
          data-layout={layout.right}
          aria-label="Agent"
          tabIndex={-1}
          {...rightKeys}
        >
          {right}
        </section>
      )}
      <EdgeHandle
        side="right"
        label="Agent"
        open={layout.right !== 'closed'}
        onToggle={toggleRight}
      />
    </>
  )
}
