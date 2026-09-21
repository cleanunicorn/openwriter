import type { EventHub } from './sse.ts'
import type { DocWatcher } from './watcher.ts'
import type { WorkspaceList } from './workspace-list.ts'
import type { Workspace } from './workspace.ts'

export type AppOptions = {
  /** Absolute path of the workspace the server owns at startup; it can be switched later. */
  workspace: string
  /**
   * The known-workspace list, outside every workspace. Required, not defaulted: only `main()`
   * resolves the real `XDG_CONFIG_HOME` location, so the type system stops a test from writing
   * the developer's own `~/.config`.
   */
  workspacesFile: string
  /** Built client (dist/client). Absent in the dev flow, where Vite serves the client. */
  clientDir?: string
  /** Adapter forced from the command line (`--adapter fake`); never persisted. */
  adapterOverride?: string
  /** Mounts the test-only fake control route. */
  fakeControl: boolean
  allowedHosts: () => string[]
  /** PATH lookup for skill prerequisites; injected in tests. */
  toolLookup?: (tool: string) => boolean
  /** Where skill templates live; defaults to the repository's `skills/`. */
  skillsDir?: string
}

/** What every route module receives. */
export type ServerContext = {
  options: AppOptions
  workspace: Workspace
  workspaces: WorkspaceList
  events: EventHub
  watcher: DocWatcher
  adapterNames: () => string[]
}
