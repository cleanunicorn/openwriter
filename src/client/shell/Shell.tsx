import { type ReactNode, useEffect } from 'react'
import { PANEL_KEYS } from './keys.ts'
import { layoutOf, setShellWidth, toggleLeft, toggleRight, useShell } from './state.ts'

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
