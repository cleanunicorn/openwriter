import type { JobRequest } from '../../shared/jobs/job-types.ts'
import type { Skill } from '../skills.ts'

/**
 * Fixed requests whose instruction.md is pinned byte for byte (fixtures/instruction-first-turn.json,
 * rendered once by the renderer as it was before conversations existed, then amended for the
 * derived `liveN` block IDs). A conversation's first turn must keep getting exactly this.
 */
const snapshot = {
  blocks: [
    { id: 'b1', raw: '# Title', kind: 'content' as const },
    { id: 'b2', raw: 'A paragraph.', kind: 'content' as const },
  ],
  gaps: ['', '\n\n', '\n'],
}

export const GOLDEN_CASES: {
  name: string
  request: JobRequest
  skill: Skill | undefined
  articlePath: string | null
}[] = [
  {
    name: 'article, blocks scope, with a selection',
    request: {
      doc: { kind: 'article', slug: 'hello' },
      scope: 'blocks',
      instruction: 'Make it louder',
      targets: ['b2'],
      selection: { blockId: 'b2', text: 'A paragraph', from: 0, to: 11 },
      snapshot,
    },
    skill: undefined,
    articlePath: 'content/posts/hello/index.md',
  },
  {
    name: 'brief, whole article',
    request: {
      doc: { kind: 'brief', slug: 'hello' },
      scope: 'article',
      instruction: 'Tighten it',
      targets: ['b1', 'b2'],
      snapshot,
    },
    skill: undefined,
    articlePath: 'content/posts/hello/index.md',
  },
  {
    name: 'strategy, research',
    request: {
      doc: { kind: 'strategy' },
      scope: 'research',
      instruction: 'What do my notes say?',
      targets: [],
      snapshot,
    },
    skill: undefined,
    articlePath: null,
  },
]
