import type { ServerEvent } from '../shared/events.ts'

type Listener = (event: ServerEvent) => void

/** In-process fan-out for server → client events. No replay: clients refetch on reconnect. */
export class EventHub {
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
