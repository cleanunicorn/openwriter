import type { ServerEvent } from '../shared/events.ts'

type Listener = (event: ServerEvent) => void

/** In-process fan-out for server → client events. No replay: clients refetch on reconnect. */
export class EventHub {
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** How to end each open event stream → the tab that opened it (null: it did not say). */
  private readonly streamEnders = new Map<() => void, string | null>()

  /** Register how to end one open event stream, and whose it is; returns the unregister function. */
  trackStream(end: () => void, tab: string | null = null): () => void {
    this.streamEnders.set(end, tab)
    return () => this.streamEnders.delete(end)
  }

  /**
   * The tabs with an event stream open right now. A job whose tab is not among them has nobody
   * left who holds its block IDs, so a tab that loads may mark it stale.
   */
  connectedTabs(): string[] {
    return [...new Set([...this.streamEnders.values()].filter((tab) => tab !== null))]
  }

  /** End every open stream. Clients reconnect by themselves; used by tests to simulate a drop. */
  dropStreams(): number {
    const count = this.streamEnders.size
    for (const end of [...this.streamEnders.keys()]) {
      end()
      // An ended stream's tab is gone at once, not when its keep-alive loop next wakes up.
      this.streamEnders.delete(end)
    }
    return count
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
