import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { PathEscapeError, resolveWithin } from '../paths.ts'

/**
 * Everything the server reads or writes inside `.zen/jobs/<id>/` after the agent has started goes
 * through this module. The job directory is the one place an agent may write, so every name in
 * it is untrusted: an agent with a shell (codex, or a skill that allows Bash) can replace
 * `progress.log`, `result.json`, or `assets/` with a symlink, a hard link to an outside file, a
 * directory, or a FIFO. Following those would let the agent read and write outside its sandbox
 * *through the server*.
 *
 * Rules: never follow a symlink at the final component (O_NOFOLLOW), never block on a FIFO
 * (O_NONBLOCK), accept only regular files with a single link, write through an exclusive
 * random-named temp file plus rename (a rename replaces the directory entry, it never writes
 * through it), and resolve assets from the trusted job directory, not from its `assets` child.
 */
export class UnsafeJobFileError extends Error {
  constructor(name: string, why: string) {
    super(`${name} is not a plain file the agent wrote (${why})`)
    this.name = 'UnsafeJobFileError'
  }
}

const NO_FOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK
/**
 * Windows has no `O_NOFOLLOW` (Node leaves it undefined, and `undefined | flags` is `flags`), so
 * an open there would follow a link without a word. It gets an `lstat` first instead: weaker —
 * a link swapped in between the two calls is still followed — but not silently absent.
 */
const HAS_NO_FOLLOW = constants.O_NOFOLLOW !== undefined

/** Refuse a symlink at `file`; a missing file is left to the open. The Windows stand-in above. */
export function refuseSymlink(file: string, label: string): void {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new UnsafeJobFileError(label, String((error as NodeJS.ErrnoException).code))
  }
  if (stats.isSymbolicLink()) throw new UnsafeJobFileError(label, 'it is a symlink')
}

function artifactPath(jobDir: string, name: string): string {
  if (name !== path.basename(name) || name === '' || name.startsWith('.')) {
    throw new PathEscapeError(`not a job artifact name: ${name}`)
  }
  return path.join(jobDir, name)
}

/** Open without following links; the returned descriptor is a regular, singly linked file. */
function openChecked(file: string, flags: number, label: string): number {
  if (!HAS_NO_FOLLOW) refuseSymlink(file, label)
  let fd: number
  try {
    fd = openSync(file, flags | NO_FOLLOW, 0o644)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw error
    throw new UnsafeJobFileError(label, code === 'ELOOP' ? 'it is a symlink' : String(code))
  }
  const stats = fstatSync(fd)
  if (!stats.isFile() || stats.nlink !== 1) {
    closeSync(fd)
    throw new UnsafeJobFileError(label, stats.isFile() ? 'it is a hard link' : 'not a regular file')
  }
  return fd
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Text of a fixed artifact, or null when it does not exist. Throws UnsafeJobFileError otherwise. */
export function readJobText(jobDir: string, name: string): string | null {
  let fd: number
  try {
    fd = openChecked(artifactPath(jobDir, name), constants.O_RDONLY, name)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Like readJobText, but an unsafe or unreadable artifact counts as "no output". */
export function readJobTextOrNull(jobDir: string, name: string): string | null {
  try {
    return readJobText(jobDir, name)
  } catch {
    return null
  }
}

/** Replace an artifact atomically. Whatever sits at the name now is replaced, never written through. */
export function writeJobText(jobDir: string, name: string, text: string): void {
  const target = artifactPath(jobDir, name)
  const temp = path.join(jobDir, `.${name}.${randomBytes(8).toString('hex')}.tmp`)
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o644,
  )
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, target)
  } catch (error) {
    unlinkSync(temp)
    throw new UnsafeJobFileError(name, String((error as NodeJS.ErrnoException).code))
  }
}

/** Append to a server-owned log. An artifact that is no longer a plain file is left alone. */
export function appendJobText(jobDir: string, name: string, text: string): boolean {
  let fd: number
  try {
    fd = openChecked(
      artifactPath(jobDir, name),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      name,
    )
  } catch {
    return false
  }
  try {
    writeSync(fd, text)
    return true
  } finally {
    closeSync(fd)
  }
}

/**
 * Bytes of a job asset (`assets/<relative>`), or null when it is not a plain file. The path is
 * resolved from the trusted job directory, so `assets` — or any directory below it — being a
 * symlink that leaves the job directory is a PathEscapeError, not a new trusted root.
 */
export function readJobAsset(jobDir: string, file: string): Buffer | null {
  const relative = file.replace(/^assets\//, '')
  const resolved = resolveWithin(jobDir, 'assets', relative)
  let fd: number
  try {
    fd = openChecked(resolved, constants.O_RDONLY, file)
  } catch {
    return null
  }
  try {
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** The shape `newJobId` mints: `YYYYMMDD-HHMMSS-xxxx`. Nothing else under `.zen/jobs` is a job. */
const JOB_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/
export const isJobId = (name: string): boolean => JOB_ID.test(name)

/**
 * Delete one job directory, `<jobsDir>/<id>`, and nothing outside it. The id must be a job id
 * (so it is a single path segment), `jobsDir` and the job directory must be real directories
 * (lstat: a symlink is refused, never followed), and the walk below lstats every entry: a
 * directory is descended into, anything else — a regular file, a FIFO, a symlink, a hard link —
 * is unlinked, which removes the name and never touches what it points at. Call it only for a
 * job whose agent has exited; nothing may be writing into the directory while it goes.
 */
export function removeJobDir(jobsDir: string, id: string): void {
  if (!isJobId(id)) throw new PathEscapeError(`not a job id: ${JSON.stringify(id)}`)
  const parent = lstatSync(jobsDir)
  if (!parent.isDirectory()) {
    throw new UnsafeJobFileError(
      '.zen/jobs',
      parent.isSymbolicLink() ? 'it is a symlink' : 'not a directory',
    )
  }
  const dir = path.join(jobsDir, id)
  const stats = lstatSync(dir)
  if (!stats.isDirectory()) {
    throw new UnsafeJobFileError(id, stats.isSymbolicLink() ? 'it is a symlink' : 'not a directory')
  }
  removeTree(dir)
}

function removeTree(dir: string): void {
  for (const name of readdirSync(dir)) {
    const child = path.join(dir, name)
    if (lstatSync(child).isDirectory()) removeTree(child)
    else unlinkSync(child)
  }
  rmdirSync(dir)
}
