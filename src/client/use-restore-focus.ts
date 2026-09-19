import { useEffect } from 'react'

/**
 * For overlays: remember what had the keyboard when the overlay opened and give it back when it
 * closes — if that element is still in the document (an editor that blurred away is not).
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected)
        previous.focus()
    }
  }, [])
}
