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

  /**
   * Follow every tracked document to where it lives now. Called when `contentDir` changes: an
   * article's slug resolves to another file, so the old directories stop producing events and
   * each document is watched at its new path. The client reads nothing on `config.changed`, so
   * without this an open document went unwatched until it happened to be read again. A document
   * whose file there is not the one the client last got says so at once, as any outside change
   * would — including a file that is not there, which pauses autosave instead of creating it.
   */
  follow(): void {
    const entries = [...this.tracked.values()]
    this.reset()
    for (const { ref, hash } of entries) {
      try {
        this.remember(ref, hash)
      } catch {
        // A path the guard now refuses is not watched; reading it would be refused the same way.
      }
    }
    for (const dir of new Set([...this.tracked.keys()].map((file) => path.dirname(file))))
      this.check(dir)
  }

  /**
   * Forget everything. Called when the workspace switches: every document belongs to the old
   * workspace, the client drops them all, and the new one's are registered as they are read.
   */
  reset(): void {
    this.close()
    this.tracked.clear()
    this.timers.clear()
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
