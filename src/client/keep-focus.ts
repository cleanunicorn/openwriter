/**
 * `onMouseDown` for a control that must not take the keyboard: without it, pressing the control
 * blurs an open block editor, which commits the block, re-renders it, and shifts the layout under
 * the pointer. Keyboard activation is unaffected.
 */
export const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault()
