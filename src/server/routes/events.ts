import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EventHub } from '../sse.ts'

export function mountEventRoutes(app: Hono, events: EventHub): void {
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe((event) => {
        // A client that went away mid-write must not become an unhandled rejection.
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })
      let dropped = false
      const untrack = events.trackStream(() => {
        // Immediately: nothing emitted after the drop may still reach this client.
        dropped = true
        unsubscribe()
        void stream.close()
      })
      const stop = () => {
        unsubscribe()
        untrack()
      }
      stream.onAbort(stop)
      await stream.writeSSE({ event: 'hello', data: '{}' })
      // Keep the connection open; a comment line every 25 s defeats idle timeouts.
      while (!stream.aborted && !dropped) {
        await stream.sleep(25_000)
        if (!stream.aborted && !dropped) await stream.write(': keep-alive\n\n')
      }
      stop()
    }),
  )
}
