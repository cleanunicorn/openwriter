import { z } from 'zod'

/**
 * What a job may touch: its target blocks, the whole article, or nothing (`research`). It lives
 * in its own module because api-types.ts needs it and job-types.ts already imports api-types.ts.
 */
export const ScopeSchema = z.enum(['blocks', 'article', 'research'])
export type Scope = z.infer<typeof ScopeSchema>
