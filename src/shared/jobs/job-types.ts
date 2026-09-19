import { z } from 'zod'
import { DocRefSchema } from '../api-types.ts'
import { SkillNameSchema } from '../names.ts'
import { ResultSchema } from './result-schema.ts'

export const ScopeSchema = z.enum(['blocks', 'article', 'research'])
export type Scope = z.infer<typeof ScopeSchema>

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

const BlockId = z.string().regex(/^b\d+$/)

export const SelectionSchema = z.object({
  blockId: BlockId,
  text: z.string(),
  /** UTF-16 offsets into the block's raw text; present only for a selection made in edit mode. */
  from: z.number().int().min(0).optional(),
  to: z.number().int().min(0).optional(),
})

export const SnapshotSchema = z.object({
  blocks: z.array(
    z.object({ id: BlockId, raw: z.string(), kind: z.enum(['frontmatter', 'content']) }),
  ),
  gaps: z.array(z.string()),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

/** What the client sends to start a job: the live document's snapshot plus the instruction. */
export const JobRequestSchema = z.object({
  doc: DocRefSchema,
  scope: ScopeSchema,
  instruction: z.string().trim().min(1).max(20000),
  skill: SkillNameSchema.optional(),
  targets: z.array(BlockId),
  selection: SelectionSchema.optional(),
  snapshot: SnapshotSchema,
})
export type JobRequest = z.infer<typeof JobRequestSchema>

export const DecisionSchema = z.enum(['accepted', 'rejected'])
export type Decision = z.infer<typeof DecisionSchema>

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

export const JobsResponseSchema = z.object({ jobs: z.array(JobSchema) })

export const DecisionsRequestSchema = z.object({
  accepted: z.array(z.number().int().min(0)),
  rejected: z.array(z.number().int().min(0)),
})
export const DecisionsResponseSchema = z.object({
  job: JobSchema,
  /** `assets/<file>` in the job → final name inside the bundle. */
  assetMap: z.record(z.string(), z.string()),
})

/** How many progress lines a job keeps in memory and on the wire; the full log is progress.log. */
export const PROGRESS_TAIL = 40

export const ACTIVE_STATES: readonly JobState[] = ['queued', 'running', 'validating', 'repairing']
export const isActive = (state: JobState): boolean => ACTIVE_STATES.includes(state)
/** A job holds its block locks until it is settled or can no longer produce a review. */
export const isUnsettled = (state: JobState): boolean => isActive(state) || state === 'ready'
