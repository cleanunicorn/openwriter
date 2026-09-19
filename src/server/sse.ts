import type { ServerEvent } from '../shared/events.ts'

type Listener = (event: ServerEvent) => void

/** In-process fan-out for server → client events. No replay: clients refetch on reconnect. */
export class EventHub {
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readonly streams = new Set<() => void>()

  /** Register how to end one open event stream; returns the unregister function. */
  trackStream(end: () => void): () => void {
    this.streams.add(end)
    return () => this.streams.delete(end)
  }

  /** End every open stream. Clients reconnect by themselves; used by tests to simulate a drop. */
  dropStreams(): number {
    const count = this.streams.size
    for (const end of [...this.streams]) end()
    return count
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
