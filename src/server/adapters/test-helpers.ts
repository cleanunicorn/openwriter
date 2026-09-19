import type { AdapterOptions } from './types.ts'

/** What the adapter unit tests start a job with: fixed paths, no overrides, no allowances. */
export const workspace = '/work/space'
export const jobDir = '/work/space/.zen/jobs/20260919-101500-ab12'
export const options = (overrides: Partial<AdapterOptions> = {}): AdapterOptions => ({
  workspace,
  jobId: '20260919-101500-ab12',
  prompt: 'Read .zen/jobs/20260919-101500-ab12/instruction.md and follow it exactly.',
  config: { extraArgs: [] },
  allow: [],
  network: false,
  ...overrides,
})
