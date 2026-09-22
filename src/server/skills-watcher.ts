import { type FSWatcher, statSync, watch } from 'node:fs'
import { PathEscapeError, resolveWithin } from './paths.ts'
import { catalogSignature, LOCAL_SKILLS_DIR, loadSkills } from './skills.ts'
import type { EventHub } from './sse.ts'
import type { Workspace } from './workspace.ts'

const DEBOUNCE_MS = 100

/**
 * Tells the client when `<workspace>/.zen/skills/` changes what the palette lists, so a skill the
 * writer just saved (or broke) shows up without a reload. It watches the skills folder when there
 * is one, else `.zen/` so the folder's creation is seen. A watch event says nothing reliable, so
 * after a debounce the catalogue is re-read and an event is emitted only if its signature moved.
 *
 * It follows a workspace switch by itself: it re-arms on the `workspace.changed` event, and
 * `follow()` (called on every `GET /api/skills`) re-arms if the root moved by any other path.
 */
export class SkillsWatcher {
  private watcher: FSWatcher | undefined
  private watched: string | undefined
  private root: string | undefined
  private signature = ''
  private timer: NodeJS.Timeout | undefined
  private readonly unsubscribe: () => void
  private readonly workspace: Workspace
  private readonly events: EventHub
  private readonly skillsDir: string | undefined

  constructor(workspace: Workspace, events: EventHub, skillsDir?: string) {
    this.workspace = workspace
    this.events = events
    this.skillsDir = skillsDir
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === 'workspace.changed') this.follow()
    })
    this.follow()
  }

  /** Watch the current workspace's skills folder, if that is not already what is watched. */
  follow(): void {
    const root = this.workspace.root
    if (root !== this.root) {
      this.root = root
      this.signature = this.currentSignature()
    }
    this.arm()
  }

  /** The folder to watch: `.zen/skills` if it is a folder inside the workspace, else `.zen`. */
  private target(): string | undefined {
    for (const segments of [LOCAL_SKILLS_DIR, [LOCAL_SKILLS_DIR[0]]]) {
      try {
        const dir = resolveWithin(this.workspace.root, ...segments)
        if (statSync(dir).isDirectory()) return dir
      } catch (error) {
        if (error instanceof PathEscapeError) continue
      }
    }
    return undefined
  }

  private arm(): void {
    const target = this.target()
    if (target === this.watched && this.watcher !== undefined) return
    this.stopWatching()
    if (target === undefined) return
    try {
      const watcher = watch(target, () => this.schedule())
      watcher.on('error', () => this.stopWatching())
      this.watcher = watcher
      this.watched = target
    } catch {
      // Gone between the stat and the watch; the next GET /api/skills re-arms.
    }
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.check(), DEBOUNCE_MS)
  }

  private currentSignature(): string {
    try {
      return catalogSignature(loadSkills(this.workspace.root, this.skillsDir))
    } catch {
      return ''
    }
  }

  private check(): void {
    // The skills folder may have been created or removed: watch whatever is there now.
    this.arm()
    const next = this.currentSignature()
    if (next === this.signature) return
    this.signature = next
    this.events.emit({ type: 'skills.changed' })
  }

  private stopWatching(): void {
    this.watcher?.close()
    this.watcher = undefined
    this.watched = undefined
  }

  close(): void {
    clearTimeout(this.timer)
    this.stopWatching()
    this.unsubscribe()
  }
}
