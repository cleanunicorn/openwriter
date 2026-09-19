import { type FSWatcher, watch } from 'node:fs'
import path from 'node:path'
import type { DocRef } from '../shared/api-types.ts'
import type { EventHub } from './sse.ts'
import type { Workspace } from './workspace.ts'

const DEBOUNCE_MS = 80

/**
 * Watches the directory of every document the client has opened (a directory watch also sees
 * editors that save by rename). A watch event never identifies a complete write, so after a
 * debounce the file is re-read and its content hash compared with the last hash the server read
 * or wrote; only a real difference becomes a `doc.changed` event.
 */
export class DocWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly tracked = new Map<string, { ref: DocRef; hash: string | null }>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly workspace: Workspace
  private readonly events: EventHub

  constructor(workspace: Workspace, events: EventHub) {
    this.workspace = workspace
    this.events = events
  }

  /** Record the hash the server just read or wrote, and make sure the directory is watched. */
  remember(ref: DocRef, hash: string | null): void {
    const file = this.workspace.docPath(ref)
    this.tracked.set(file, { ref, hash })
    const dir = path.dirname(file)
    if (this.watchers.has(dir)) return
    try {
      const watcher = watch(dir, () => this.schedule(dir))
      watcher.on('error', () => this.drop(dir))
      this.watchers.set(dir, watcher)
    } catch {
      // The directory does not exist yet (a brief that was never saved); the next read retries.
    }
  }

  private drop(dir: string): void {
    this.watchers.get(dir)?.close()
    this.watchers.delete(dir)
  }

  private schedule(dir: string): void {
    clearTimeout(this.timers.get(dir))
    this.timers.set(
      dir,
      setTimeout(() => this.check(dir), DEBOUNCE_MS),
    )
  }

  private check(dir: string): void {
    for (const [file, entry] of this.tracked) {
      if (path.dirname(file) !== dir) continue
      let hash: string | null
      try {
        hash = this.workspace.readDoc(entry.ref).hash
      } catch {
        continue
      }
      if (hash === entry.hash) continue
      entry.hash = hash
      this.events.emit({ type: 'doc.changed', ref: entry.ref, hash })
    }
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
