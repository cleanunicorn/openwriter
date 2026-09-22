import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { HelloEvent } from '../../shared/events.ts'
import { TabIdSchema } from '../../shared/jobs/job-types.ts'
import type { EventHub } from '../sse.ts'

/**
 * `root` is read when a stream opens: its `hello` names the workspace every event after it is
 * about, until a `workspace.changed` names the next one (see `connectEvents` in the client).
 */
export function mountEventRoutes(app: Hono, events: EventHub, root: () => string): void {
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      // Which tab this is, so a tab that loads later knows whose jobs still have a tab to apply
      // them. Anything that is not a tab ID is simply not counted.
      const tab = TabIdSchema.safeParse(c.req.query('tab'))
      const unsubscribe = events.subscribe((event) => {
        // A client that went away mid-write must not become an unhandled rejection.
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {})
      })
      let dropped = false
      const untrack = events.trackStream(
        () => {
          // Immediately: nothing emitted after the drop may still reach this client.
          dropped = true
          unsubscribe()
          void stream.close()
        },
        tab.success ? tab.data : null,
      )
      const stop = () => {
        unsubscribe()
        untrack()
      }
      stream.onAbort(stop)
      // Synchronously after `subscribe`: no event can come between the two, so the root named
      // here is the one the first event on this stream is about.
      const hello: HelloEvent = { root: root() }
      await stream.writeSSE({ event: 'hello', data: JSON.stringify(hello) })
      // Keep the connection open; a comment line every 25 s defeats idle timeouts.
      while (!stream.aborted && !dropped) {
        await stream.sleep(25_000)
        if (!stream.aborted && !dropped) await stream.write(': keep-alive\n\n')
      }
      stop()
    }),
  )
}
