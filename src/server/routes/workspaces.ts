import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Hono } from 'hono'
import { DEFAULT_CONFIG } from '../../shared/config-schema.ts'
import {
  CreateWorkspaceRequestSchema,
  EraseWorkspaceRequestSchema,
  OpenWorkspaceRequestSchema,
  RenameWorkspaceRequestSchema,
  type WorkspacesResponse,
} from '../../shared/workspaces-schema.ts'
import { saveConfig } from '../config.ts'
import type { ServerContext } from '../context.ts'
import { HttpError, parseBody } from '../http.ts'
import type { JobManager } from '../jobs/manager.ts'
import { realpathOrSelf } from '../workspace-list.ts'
import { Workspace } from '../workspace.ts'

/**
 * The tracked sample every test copies from. It is identified by path — there is no marker file
 * inside it, and adding one would change what `createTestApp` produces. The gitignored copy at
 * `.openwrite/sample-workspace` is deliberately NOT protected: `defaultWorkspace()` re-creates
 * it, and `DECISIONS.md` already documents deleting it as the way to reset the playground.
 */
const TRACKED_SAMPLE = path.resolve(import.meta.dirname, '..', '..', '..', 'sample-workspace')

const SWITCH_REASON = 'The editor moved to another workspace. This job was not reviewed.'

const STRATEGY = `# Strategy

Who reads this blog, what it sounds like, and how a post is built. Agents read
this file before they touch a draft.
`

/** An existing, readable directory named by an absolute path — resolved to its real location. */
function validRoot(raw: string): string {
  if (!path.isAbsolute(raw)) throw new HttpError(400, `the workspace path must be absolute: ${raw}`)
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(raw)
  } catch {
    throw new HttpError(400, `there is no directory at ${raw}`)
  }
  if (!stats.isDirectory()) throw new HttpError(400, `not a directory: ${raw}`)
  try {
    accessSync(raw, constants.R_OK | constants.X_OK)
  } catch {
    throw new HttpError(400, `that directory cannot be read: ${raw}`)
  }
  return realpathSync(raw)
}

/**
 * `<home>/<name>`, and nowhere else. The schema already made `name` kebab case, which cannot spell
 * `..`, a separator or an absolute path; this guards what a name cannot: a symlink planted at
 * `<home>/<name>`, whatever it points at, is refused rather than followed. The home is created on
 * first use and resolved to its real location, and it may never be the filesystem root.
 */
function homeChild(home: string, name: string): string {
  mkdirSync(home, { recursive: true })
  const realHome = realpathSync(home)
  if (path.dirname(realHome) === realHome) {
    throw new HttpError(400, 'the workspaces folder cannot be the root of the filesystem')
  }
  const root = path.join(realHome, name)
  if (path.dirname(root) !== realHome) throw new HttpError(400, `not a workspace name: ${name}`)
  try {
    if (lstatSync(root).isSymbolicLink()) {
      throw new HttpError(400, `${name} is a link, not a workspace folder; nothing was opened`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return root
}

function scaffold(root: string): void {
  if (existsSync(root) && readdirSync(root).length > 0) {
    throw new HttpError(400, `${root} already has something in it; pick another name`)
  }
  mkdirSync(root, { recursive: true })
  // A link swapped in between the check and the mkdir would be followed by the writes below.
  if (realpathSync(root) !== root) throw new HttpError(400, `${root} moved while it was created`)
  writeFileSync(path.join(root, 'strategy.md'), STRATEGY)
  saveConfig(root, DEFAULT_CONFIG)
  mkdirSync(path.join(root, 'content', 'posts'), { recursive: true })
  mkdirSync(path.join(root, 'sources'), { recursive: true })
}

export function mountWorkspaceRoutes(app: Hono, context: ServerContext, jobs: JobManager): void {
  const { workspace, workspaces, watcher, events } = context
  const home = context.options.workspacesDir

  // One mutation at a time. Opening, creating and erasing all read the list, change the world and
  // write it back; two of them interleaving across the `await` in `quiesce` would lose one of the
  // two writes, or retarget while another request was halfway through erasing.
  let chain: Promise<unknown> = Promise.resolve()
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => {})
    return next
  }

  const body = (): WorkspacesResponse => ({
    active: {
      root: workspace.root,
      label: workspaces.findByPath(workspace.root)?.label ?? path.basename(workspace.root),
    },
    home: realpathOrSelf(home),
    entries: workspaces.entries(),
  })

  /**
   * The switch. Everything after `quiesce` is one synchronous block on purpose: `writeDoc` is
   * fully synchronous, so a concurrent `PUT /api/docs/:kind/:slug` either completes entirely
   * against the old root or begins entirely against the new one. An `await` in here would let a
   * half-applied switch write the old workspace's document into the new workspace.
   */
  const switchTo = async (next: string, label?: string): Promise<void> => {
    if (next === realpathOrSelf(workspace.root)) {
      if (label !== undefined) workspaces.touch(next, label)
      return
    }
    await jobs.quiesce(SWITCH_REASON)
    workspace.retarget(next)
    watcher.reset()
    jobs.rebind()
    const entry = workspaces.touch(next, label)
    events.emit({ type: 'workspace.changed', root: next, label: entry.label })
  }

  app.get('/api/workspaces', (c) => c.json(body()))

  // No route here takes a filesystem path. A workspace is reached by a name inside `home` or by
  // the id of one the list already remembers; any other root enters the list only through the
  // command line (`--workspace`), which only the local user can type.
  app.post('/api/workspaces/open', async (c) => {
    const { name } = await parseBody(c, OpenWorkspaceRequestSchema)
    return c.json(
      await serialised(async () => {
        await switchTo(validRoot(homeChild(home, name)))
        return body()
      }),
    )
  })

  app.post('/api/workspaces/:id/open', async (c) => {
    const id = c.req.param('id')
    return c.json(
      await serialised(async () => {
        const entry = workspaces.find(id)
        if (entry === undefined) throw new HttpError(404, 'that workspace is not in the list')
        await switchTo(validRoot(entry.path))
        return body()
      }),
    )
  })

  app.post('/api/workspaces', async (c) => {
    const { name, label } = await parseBody(c, CreateWorkspaceRequestSchema)
    return c.json(
      await serialised(async () => {
        const root = homeChild(home, name)
        scaffold(root)
        await switchTo(validRoot(root), label)
        return body()
      }),
      201,
    )
  })

  app.patch('/api/workspaces/:id', async (c) => {
    const { label } = await parseBody(c, RenameWorkspaceRequestSchema)
    if (workspaces.rename(c.req.param('id'), label) === undefined) {
      throw new HttpError(404, 'that workspace is not in the list')
    }
    return c.json(body())
  })

  app.delete('/api/workspaces/:id', (c) => {
    if (!workspaces.forget(c.req.param('id'))) {
      throw new HttpError(404, 'that workspace is not in the list')
    }
    return c.json(body())
  })

  /**
   * The one destructive route. It takes an **id**, never a path: the root it deletes is read from
   * the list the server owns, so a root the list does not own cannot even be expressed in the
   * request. Every guard below refuses before anything is removed.
   */
  app.post('/api/workspaces/:id/erase', async (c) => {
    const { confirm } = await parseBody(c, EraseWorkspaceRequestSchema)
    const id = c.req.param('id')
    return c.json(
      await serialised(async () => {
        const entry = workspaces.find(id)
        if (entry === undefined) throw new HttpError(404, 'that workspace is not in the list')
        if (confirm !== entry.label) {
          throw new HttpError(
            400,
            `type the workspace's name exactly — "${entry.label}" — to delete it`,
          )
        }
        const root = entry.path
        if (realpathOrSelf(root) === realpathOrSelf(workspace.root)) {
          throw new HttpError(409, 'that workspace is open; switch to another one first')
        }
        if (realpathOrSelf(root) === realpathOrSelf(TRACKED_SAMPLE)) {
          throw new HttpError(400, 'the sample workspace this project ships cannot be deleted')
        }
        let stats: ReturnType<typeof lstatSync>
        try {
          stats = lstatSync(root)
        } catch {
          // Already gone: the entry is all that is left, so drop it and say so.
          workspaces.forget(id)
          return body()
        }
        // Never follow the top: a recorded root that is itself a symlink would delete whatever it
        // points at. Below it, `rm -r` unlinks symlinks instead of walking through them, which
        // the AC12.2 test proves against a real decoy rather than trusting.
        if (!stats.isDirectory() || realpathSync(root) !== path.resolve(root)) {
          throw new HttpError(400, `${root} is not a plain directory; nothing was deleted`)
        }
        const target = new Workspace(root)
        const problem = target.contentDirProblem()
        if (problem !== null) {
          throw new HttpError(400, `${problem}; fix contentDir before deleting this workspace`)
        }
        if (target.contentOutsideWorkspace()) {
          throw new HttpError(
            400,
            `its contentDir points at ${target.contentRoot()}, outside the workspace, so deleting the workspace would either miss those files or reach outside it; remove it from the list instead`,
          )
        }
        rmSync(root, { recursive: true, force: true })
        workspaces.forget(id)
        return body()
      }),
    )
  })
}
