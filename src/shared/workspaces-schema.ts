import { z } from 'zod'
import { WorkspaceNameSchema } from './names.ts'

/** A hand-edited label must not become an unbounded string in the palette. */
const LabelSchema = z.string().trim().min(1).max(120)

/**
 * A POSIX (`/…`) or Windows (`C:\…`, `\\server\…`) absolute path. Written without `node:path`
 * because this module is shared with the client. A relative path is refused, never resolved: the
 * erase route deletes `path`, and a relative one would resolve against the server's own working
 * directory — the openwrite checkout that `npm start` runs from.
 */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/
const isAbsolutePath = (value: string): boolean => ABSOLUTE_PATH.test(value)

/** One remembered workspace. `id` is the handle every mutating route takes; `path` is absolute. */
const WorkspaceEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  path: z.string().refine(isAbsolutePath, 'a workspace path must be absolute'),
  label: LabelSchema,
})
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>

/**
 * `~/.config/openwrite/workspaces.json`. `version` and `entries` both default, so a partial or
 * older file still loads; a file that fails this schema outright degrades to an empty list.
 */
export const WorkspacesFileSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(WorkspaceEntrySchema).default([]),
})

const ActiveWorkspaceSchema = z.object({ root: z.string(), label: z.string() })

export const WorkspacesResponseSchema = z.object({
  active: ActiveWorkspaceSchema,
  /** The one folder new workspaces are created in, and opened from by name. */
  home: z.string(),
  entries: z.array(WorkspaceEntrySchema),
})
export type WorkspacesResponse = z.infer<typeof WorkspacesResponseSchema>

/**
 * Opening and creating take a **name**, never a path: the server resolves it inside its own
 * workspaces folder, so a request cannot point the editor at `/`, at `..`, or anywhere else on
 * disk. Strict, like the erase body, so a stray `path` is refused instead of silently stripped.
 */
export const OpenWorkspaceRequestSchema = z.strictObject({ name: WorkspaceNameSchema })
export const CreateWorkspaceRequestSchema = z.strictObject({
  name: WorkspaceNameSchema,
  label: LabelSchema.optional(),
})
export const RenameWorkspaceRequestSchema = z.object({ label: LabelSchema })

/**
 * Strict on purpose: this is the destructive route, so a body carrying a `path` is refused
 * outright rather than silently stripped (a plain `z.object` strips unknown keys). The server deletes the root it reads from the list, never
 * one the client names.
 */
export const EraseWorkspaceRequestSchema = z.strictObject({ confirm: z.string().min(1) })
