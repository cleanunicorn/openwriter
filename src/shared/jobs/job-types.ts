import { z } from 'zod'
import { DocRefSchema } from '../api-types.ts'
import { BlockIdSchema, BlockKindSchema } from '../blocks/types.ts'
import { SkillNameSchema } from '../names.ts'
import { ResultSchema } from './result-schema.ts'
import { type Scope, ScopeSchema } from './scope.ts'

export { type Scope, ScopeSchema }

/**
 * queued → running → validating → (repairing →) ready → settled, or failed | cancelled | stale.
 * `ready` means the process finished and the writer has not decided every op yet; process state
 * and review decisions are separate things.
 */
export const JobStateSchema = z.enum([
  'queued',
  'running',
  'validating',
  'repairing',
  'ready',
  'settled',
  'failed',
  'cancelled',
  'stale',
])
export type JobState = z.infer<typeof JobStateSchema>

export const FailureReasonSchema = z.enum([
  'missing-cli',
  'missing-tool',
  'auth',
  'timeout',
  'invalid-result',
  'exit',
])
export type FailureReason = z.infer<typeof FailureReasonSchema>

export const SelectionSchema = z.object({
  blockId: BlockIdSchema,
  text: z.string(),
  /** UTF-16 offsets into the block's raw text; present only for a selection made in edit mode. */
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
})

export const SnapshotSchema = z.object({
  blocks: z.array(z.object({ id: BlockIdSchema, raw: z.string(), kind: BlockKindSchema })),
  gaps: z.array(z.string()),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

/** How an earlier turn of the conversation ended, as the writer saw it. */
export const TurnOutcomeSchema = z.enum([
  'still running',
  'awaiting review',
  'accepted',
  'rejected',
  'partly accepted',
  'answered',
  'done',
  'failed',
  'cancelled',
  'stale',
])
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>

/**
 * One earlier turn of the right panel's conversation. The caps are loose on purpose: the server
 * re-bounds whatever arrives when it writes `conversation.md` (shared/jobs/conversation.ts).
 */
export const TurnSchema = z.object({
  instruction: z.string().max(20000),
  scope: ScopeSchema,
  skill: z.string().max(200).nullable(),
  summary: z.string().max(20000).nullable(),
  notes: z.string().max(100000).nullable(),
  outcome: TurnOutcomeSchema,
})
export type Turn = z.infer<typeof TurnSchema>

/**
 * One browser tab, for as long as it lives — a reload keeps it (client/state/session.ts). Block IDs
 * are that tab's own, so a job can only be applied by the tab that asked for it.
 */
export const TabIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/)

/** What the client sends to start a job: the live document's snapshot plus the instruction. */
export const JobRequestSchema = z.object({
  doc: DocRefSchema,
  scope: ScopeSchema,
  instruction: z.string().trim().min(1).max(20000),
  skill: SkillNameSchema.optional(),
  targets: z.array(BlockIdSchema),
  selection: SelectionSchema.optional(),
  snapshot: SnapshotSchema,
  /** Earlier turns about the same document, oldest first; absent on a conversation's first turn. */
  conversation: z.array(TurnSchema).max(20).optional(),
  /** The tab that asked; its block IDs are the ones in `targets` and `snapshot`. */
  owner: TabIdSchema.optional(),
})
export type JobRequest = z.infer<typeof JobRequestSchema>

export const DecisionSchema = z.enum(['accepted', 'rejected'])

export const JobSchema = z.object({
  id: z.string(),
  doc: DocRefSchema,
  scope: ScopeSchema,
  instruction: z.string(),
  skill: z.string().nullable(),
  adapter: z.string(),
  state: JobStateSchema,
  reason: FailureReasonSchema.nullable(),
  error: z.string().nullable(),
  targets: z.array(z.string()),
  /**
   * The tab whose block IDs `targets` and the ops name; null for a job from before tabs were
   * recorded. Another tab shows the job but never applies it.
   */
  owner: z.string().nullable().default(null),
  /** Raw text of every block at request time, for "changed since request". */
  snapshotRaws: z.record(z.string(), z.string()),
  result: ResultSchema.nullable(),
  /** Kept for failed and stale jobs so nothing an agent produced is lost. */
  rawOutput: z.string().nullable(),
  /** Op index → decision. */
  decisions: z.record(z.string(), DecisionSchema),
  progress: z.array(z.string()),
  /** Bumped on every server-side change; lets the client ignore an older copy of the job. */
  revision: z.number().int().min(0).default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Job = z.infer<typeof JobSchema>

export const JobsResponseSchema = z.object({
  jobs: z.array(JobSchema),
  /** Tabs with an open event stream now: a job whose owner is not among them has no tab to apply it. */
  tabs: z.array(z.string()).default([]),
})

export const DecisionsRequestSchema = z.object({
  accepted: z.array(z.number().int().min(0)),
  rejected: z.array(z.number().int().min(0)),
})
/** Op indices the client accepted but could not apply: their block was gone by then. */
export const WithdrawRequestSchema = z.object({
  indices: z.array(z.number().int().min(0)).min(1),
})
export const DecisionsResponseSchema = z.object({
  job: JobSchema,
  /** `assets/<file>` in the job → final name inside the bundle. */
  assetMap: z.record(z.string(), z.string()),
})

/** How many progress lines a job keeps in memory and on the wire; the full log is progress.log. */
export const PROGRESS_TAIL = 40

const ACTIVE_STATES: readonly JobState[] = ['queued', 'running', 'validating', 'repairing']
export const isActive = (state: JobState): boolean => ACTIVE_STATES.includes(state)
/** A job holds its block locks until it is settled or can no longer produce a review. */
export const isUnsettled = (state: JobState): boolean => isActive(state) || state === 'ready'

/**
 * Nothing will run for it and nothing waits for the writer's decision, so its directory may be
 * cleared. `ready` is never finished: a proposal awaiting review is kept until it is decided.
 */
const FINISHED_STATES: readonly JobState[] = ['settled', 'failed', 'cancelled', 'stale']
export const isFinished = (state: JobState): boolean => FINISHED_STATES.includes(state)

/** `POST /api/jobs/clear-finished`: what was deleted, what was kept, and what was refused. */
export const ClearJobsResponseSchema = z.object({
  removed: z.array(z.string()),
  /** Job directories left alone because their job is queued, running, or awaiting review. */
  kept: z.number().int().min(0),
  /** Directories that looked eligible but were not deleted, with why (a symlink, an error). */
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
})
export type ClearJobsResponse = z.infer<typeof ClearJobsResponseSchema>
