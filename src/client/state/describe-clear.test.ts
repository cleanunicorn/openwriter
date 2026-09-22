import { describe, expect, it } from 'vitest'
import { describeClear } from './describe-clear.ts'

describe('describeClear', () => {
  it('says what went and what stayed', () => {
    expect(describeClear({ removed: ['a'], kept: 0, skipped: [] })).toBe('Cleared 1 finished job.')
    expect(describeClear({ removed: ['a', 'b'], kept: 2, skipped: [] })).toBe(
      'Cleared 2 finished jobs. Kept 2 jobs that are still queued, running or awaiting review.',
    )
  })

  it('says when there was nothing to clear', () => {
    expect(describeClear({ removed: [], kept: 1, skipped: [] })).toBe(
      'No finished jobs to clear. Kept 1 job that is still queued, running or awaiting review.',
    )
  })

  it('names the first directory it refused, and counts the rest', () => {
    expect(
      describeClear({
        removed: [],
        kept: 0,
        skipped: [
          { id: 'x', reason: 'not a plain directory' },
          { id: 'y', reason: 'job.json is missing or invalid' },
        ],
      }),
    ).toBe('No finished jobs to clear. Left 2 job directories alone (x: not a plain directory).')
  })
})
