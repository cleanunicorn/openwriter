import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type WorkspaceEntry, WorkspacesFileSchema } from '../shared/workspaces-schema.ts'

/** Same root, written two ways (a symlink, a trailing slash) is one workspace. */
function sameRoot(a: string, b: string): boolean {
  return realpathOrSelf(a) === realpathOrSelf(b)
}

/** realpath, or the resolved path when it does not exist: an entry may outlive its directory. */
export function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * The list of known workspaces, one small JSON file outside every workspace.
 *
 * The file path is injected and never resolved from the environment here — only `main()` knows
 * the real `XDG_CONFIG_HOME` location, so no test can reach the developer's own `~/.config`.
 * The file is read on every call: it is tiny, an edit from outside is picked up for free, and
 * there is no cache to invalidate when the workspace changes.
 */
export class WorkspaceList {
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /**
   * Never throws. A missing, unreadable or invalid file is an empty list, so a hand-edited file
   * degrades the list instead of stopping the editor from starting.
   */
  entries(): WorkspaceEntry[] {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = WorkspacesFileSchema.safeParse(JSON.parse(text))
      return parsed.success ? parsed.data.entries : []
    } catch {
      return []
    }
  }

  find(id: string): WorkspaceEntry | undefined {
    return this.entries().find((entry) => entry.id === id)
  }

  findByPath(root: string): WorkspaceEntry | undefined {
    return this.entries().find((entry) => sameRoot(entry.path, root))
  }

  /** Remember this root, or refresh the entry that already has it. Never duplicates a root. */
  touch(root: string, label?: string): WorkspaceEntry {
    const entries = this.entries()
    const index = entries.findIndex((entry) => sameRoot(entry.path, root))
    const existing = entries[index]
    if (existing !== undefined) {
      const updated = { ...existing, path: root, label: label ?? existing.label }
      entries[index] = updated
      this.save(entries)
      return updated
    }
    const entry: WorkspaceEntry = {
      id: randomBytes(6).toString('hex'),
      path: root,
      label: label ?? path.basename(root),
    }
    this.save([...entries, entry])
    return entry
  }

  /** The label only: renaming an entry never touches a file inside the workspace. */
  rename(id: string, label: string): WorkspaceEntry | undefined {
    const entries = this.entries()
    const index = entries.findIndex((entry) => entry.id === id)
    const existing = entries[index]
    if (existing === undefined) return undefined
    const updated = { ...existing, label }
    entries[index] = updated
    this.save(entries)
    return updated
  }

  /** Drop the entry. Deletes nothing on disk — that is `erase`, a different route. */
  forget(id: string): boolean {
    const entries = this.entries()
    const remaining = entries.filter((entry) => entry.id !== id)
    if (remaining.length === entries.length) return false
    this.save(remaining)
    return true
  }

  /** Atomic: a temp file in the same directory, then rename, as `saveConfig` and `writeDoc` do. */
  private save(entries: WorkspaceEntry[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    renameSync(temp, this.file)
  }
}
