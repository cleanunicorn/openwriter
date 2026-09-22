import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOLDEN_CASES } from './instruction-golden-cases.ts'
import { renderInstruction } from './job-files.ts'

// Rendered once by the renderer as it was before conversations existed (main at 4798921), then
// amended by hand for one sentence: the derived `liveN` block IDs (#14).
const golden = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'instruction-first-turn.json'), 'utf8'),
) as Record<string, string>

describe("a conversation's first turn", () => {
  it('has a golden instruction for every case', () => {
    expect(Object.keys(golden).sort()).toEqual(GOLDEN_CASES.map((c) => c.name).sort())
  })

  for (const c of GOLDEN_CASES) {
    it(`gets exactly the instruction.md it always did: ${c.name}`, () => {
      const without = renderInstruction('JOBID', c.request, c.skill, c.articlePath)
      const empty = renderInstruction(
        'JOBID',
        { ...c.request, conversation: [] },
        c.skill,
        c.articlePath,
      )
      expect(without).toBe(golden[c.name])
      expect(empty).toBe(golden[c.name])
    })
  }
})
