import { useSyncExternalStore } from 'react'

export type Store<S> = {
  get: () => S
  set: (update: (state: S) => S) => void
  subscribe: (listener: () => void) => () => void
}

/** A ~30-line external store. Reducers stay pure; React reads slices with `useStore`. */
export function createStore<S>(initial: S): Store<S> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (update) => {
      const next = update(state)
      if (next === state) return
      state = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** The selector must return an existing reference (or a primitive) so snapshots stay stable. */
export function useStoreSlice<S, T>(store: Store<S>, selector: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()))
}
