import { z } from 'zod'

/** A hand-edited label must not become an unbounded string in the palette. */
const LabelSchema = z.string().trim().min(1).max(120)

/** One remembered workspace. `id` is the handle every mutating route takes; `path` is absolute. */
export const WorkspaceEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  path: z.string().min(1),
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
export type WorkspacesFile = z.infer<typeof WorkspacesFileSchema>

export const ActiveWorkspaceSchema = z.object({ root: z.string(), label: z.string() })
export type ActiveWorkspace = z.infer<typeof ActiveWorkspaceSchema>

export const WorkspacesResponseSchema = z.object({
  active: ActiveWorkspaceSchema,
  entries: z.array(WorkspaceEntrySchema),
})
export type WorkspacesResponse = z.infer<typeof WorkspacesResponseSchema>

export const OpenWorkspaceRequestSchema = z.object({ path: z.string().min(1) })
export const CreateWorkspaceRequestSchema = z.object({
  path: z.string().min(1),
  label: LabelSchema.optional(),
})
export const RenameWorkspaceRequestSchema = z.object({ label: LabelSchema })

/**
 * Strict on purpose, and the only strict schema in the project: this is the destructive route,
 * so a body carrying a `path` is refused outright rather than silently stripped (a plain
 * `z.object` strips unknown keys). The server deletes the root it reads from the list, never
 * one the client names.
 */
export const EraseWorkspaceRequestSchema = z.strictObject({ confirm: z.string().min(1) })
