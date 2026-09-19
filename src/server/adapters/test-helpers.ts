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

/** Whether a process still exists: signal 0 only checks, it delivers nothing. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
