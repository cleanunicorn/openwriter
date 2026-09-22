import { z } from 'zod'
import { HerdrSessionSchema } from './names.ts'

/** Per-adapter overrides. `command` replaces the executable, `baseArgs` the verified defaults. */
export const AdapterConfigSchema = z.object({
  command: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  baseArgs: z.array(z.string()).optional(),
  extraArgs: z.array(z.string()).default([]),
  /** herdr only: the named herdr session jobs run in (default `openwrite-jobs`). */
  session: HerdrSessionSchema.optional(),
})
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>

/**
 * Which edge panels are open. A toggle, not a setting: the Settings form does not show it.
 * `prefault` (not `default`): in zod 4 `.default({})` would skip the inner defaults.
 */
export const UiStateSchema = z
  .object({
    leftPanel: z.boolean().default(false),
    rightPanel: z.boolean().default(false),
  })
  .prefault({})
export type UiState = z.infer<typeof UiStateSchema>

/**
 * `<workspace>/.zen/config.json`. Every key has a default, so an older or partial file keeps
 * loading. No secrets are stored: agent CLIs use the writer's own logins.
 */
export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  mainAgent: z.string().min(1).default('claude'),
  /** Task kind (for example `image`) → adapter name. Resolved before `mainAgent`. */
  taskAgents: z.record(z.string(), z.string().min(1)).default({}),
  /** Relative to the workspace, or absolute to point straight into a Hugo site's content dir. */
  contentDir: z.string().min(1).default('content'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  concurrency: z.number().int().min(1).max(16).default(3),
  jobTimeoutSec: z.number().int().min(1).max(7200).default(600),
  /**
   * Finished jobs (done, failed, cancelled, or dismissed) not updated for this many days are
   * deleted when the workspace opens. 0 keeps them until cleared by hand. See DECISIONS.md.
   */
  jobRetentionDays: z.number().int().min(0).max(3650).default(30),
  adapters: z.record(z.string(), AdapterConfigSchema).default({}),
  ui: UiStateSchema,
})
export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})
