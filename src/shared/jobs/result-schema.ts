import { z } from 'zod'
import { BlockIdSchema as BlockId } from '../blocks/types.ts'

/** The four ops of the file contract. Strict: an unknown op or key rejects the whole result. */
const OpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('replace'), block_id: BlockId, markdown: z.string() }),
  z.strictObject({ op: z.literal('insert_after'), block_id: BlockId, markdown: z.string() }),
  z.strictObject({ op: z.literal('insert_before'), block_id: BlockId, markdown: z.string() }),
  z.strictObject({ op: z.literal('delete'), block_id: BlockId }),
])
export type Op = z.infer<typeof OpSchema>

const AssetSchema = z.strictObject({ file: z.string().min(1), alt: z.string().optional() })

/**
 * `result.json`, the shape of the job file contract (README, "The job file contract"). `summary`
 * is required; `ops`, `assets` and `notes` default to empty so a research answer can be just a
 * summary plus notes.
 */
export const ResultSchema = z.strictObject({
  summary: z.string(),
  ops: z.array(OpSchema).default([]),
  assets: z.array(AssetSchema).default([]),
  notes: z.string().default(''),
})
export type Result = z.infer<typeof ResultSchema>
