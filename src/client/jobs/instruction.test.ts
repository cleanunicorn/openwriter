import { describe, expect, it } from 'vitest'
import { parseInstruction } from './instruction.ts'

describe('parseInstruction', () => {
  it('takes plain text as the instruction, with no skill', () => {
    expect(parseInstruction('  tighten the intro  ')).toEqual({
      instruction: 'tighten the intro',
      skill: undefined,
    })
  })

  it('reads /name at the start as a skill and the rest as the instruction', () => {
    expect(parseInstruction('/diagram draw the pipeline')).toEqual({
      instruction: 'draw the pipeline',
      skill: 'diagram',
    })
  })

  it('runs a bare skill with a sentence of its own', () => {
    expect(parseInstruction('/diagram')).toEqual({
      instruction: 'Run the diagram skill.',
      skill: 'diagram',
    })
  })

  it('falls back to a preset skill, and lets a typed one win', () => {
    expect(parseInstruction('draw it', 'image')).toEqual({ instruction: 'draw it', skill: 'image' })
    expect(parseInstruction('/diagram draw it', 'image').skill).toBe('diagram')
  })

  it('leaves an empty message empty', () => {
    expect(parseInstruction('   ')).toEqual({ instruction: '', skill: undefined })
  })
})
