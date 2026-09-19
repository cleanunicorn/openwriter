import type { EventHub } from './sse.ts'
import type { DocWatcher } from './watcher.ts'
import type { Workspace } from './workspace.ts'

export type AppOptions = {
  /** Absolute path of the workspace the server owns. */
  workspace: string
  /** Built client (dist/client). Absent in the dev flow, where Vite serves the client. */
  clientDir?: string
  /** Adapter forced from the command line (`--adapter fake`); never persisted. */
  adapterOverride?: string
  /** Mounts the test-only fake control route. */
  fakeControl: boolean
  allowedHosts: () => string[]
}

/** What every route module receives. */
export type ServerContext = {
  options: AppOptions
  workspace: Workspace
  events: EventHub
  watcher: DocWatcher
  adapterNames: () => string[]
}
