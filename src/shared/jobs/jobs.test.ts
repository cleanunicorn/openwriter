import { describe, expect, it } from 'vitest'
import { serialise } from '../blocks/index.ts'
import { setup } from '../blocks/test-helpers.ts'
import { applyOps } from './apply-ops.ts'
import { referencedAssets, rewriteAssetRefs } from './asset-refs.ts'
import type { Snapshot } from './job-types.ts'
import { type Op, ResultSchema } from './result-schema.ts'
import {
  blockersOf,
  lostItsTargets,
  type Claim,
  changedSinceRequest,
  missingTargets,
  startable,
} from './scheduler.ts'
import { effectiveTargets, validateOps } from './validate-ops.ts'

const snapshot: Snapshot = {
  blocks: [
    { id: 'b1', raw: '---\ntitle: x\n---', kind: 'frontmatter' },
    { id: 'b2', raw: 'A', kind: 'content' },
    { id: 'b3', raw: 'B', kind: 'content' },
    { id: 'b4', raw: 'C', kind: 'content' },
  ],
  gaps: ['', '\n\n', '\n\n', '\n\n', '\n'],
}
const result = (partial: Record<string, unknown>) =>
  ResultSchema.parse({ summary: 's', ...partial })

describe('result.json schema', () => {
  it('accepts the shape of the job file contract', () => {
    const parsed = ResultSchema.safeParse({
      summary: 'one line',
      ops: [
        { op: 'replace', block_id: 'b12', markdown: '...' },
        { op: 'insert_after', block_id: 'b12', markdown: '...' },
        { op: 'insert_before', block_id: 'b12', markdown: '...' },
        { op: 'delete', block_id: 'b13' },
      ],
      assets: [{ file: 'assets/diagram.png', alt: '...' }],
      notes: 'free-form',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts both ID namespaces a snapshot can carry: stored and derived', () => {
    // `liveDoc` names a block that exists only in the open editor `live<n>`, an ID the store
    // never mints. An agent that addresses it must not have its whole result rejected; applying
    // the op finds no such block and the op is withdrawn, like any op on a vanished block.
    for (const id of ['b1', 'b12', 'live1', 'live42'])
      expect(
        ResultSchema.safeParse({ summary: 's', ops: [{ op: 'delete', block_id: id }] }).success,
      ).toBe(true)
  })

  it.each([
    ['an unknown op', { summary: 's', ops: [{ op: 'move', block_id: 'b1' }] }],
    [
      'an unknown key on an op',
      { summary: 's', ops: [{ op: 'delete', block_id: 'b1', force: true }] },
    ],
    ['an unknown top-level key', { summary: 's', ops: [], path: '/etc/passwd' }],
    ['a missing summary', { ops: [] }],
    ['replace without markdown', { summary: 's', ops: [{ op: 'replace', block_id: 'b1' }] }],
    ['a malformed block id', { summary: 's', ops: [{ op: 'delete', block_id: '../b1' }] }],
    ['ops that is not an array', { summary: 's', ops: 'none' }],
  ])('rejects %s', (_name, value) => {
    expect(ResultSchema.safeParse(value).success).toBe(false)
  })

  it.each(['live', 'b', 'd1', 'live1x', 'b1 ', 'Live1', 'liveb1', 'b-1', 'live01\n'])(
    'rejects the block id %j: only b<n> and live<n> exist',
    (id) => {
      const value = { summary: 's', ops: [{ op: 'delete', block_id: id }] }
      expect(ResultSchema.safeParse(value).success).toBe(false)
    },
  )

  it('defaults ops, assets and notes so a research answer can be short', () => {
    expect(ResultSchema.parse({ summary: 's' })).toEqual({
      summary: 's',
      ops: [],
      assets: [],
      notes: '',
    })
  })
})

describe('op validation', () => {
  const blocks = { scope: 'blocks' as const, targets: ['b3'], snapshot }

  it('blocks scope: ops may touch the targets or insert next to them', () => {
    const ok = result({
      ops: [
        { op: 'replace', block_id: 'b3', markdown: 'B2' },
        { op: 'insert_after', block_id: 'b3', markdown: 'X' },
        { op: 'insert_before', block_id: 'b3', markdown: 'Y' },
      ],
    })
    expect(validateOps(ok, blocks)).toEqual([])
  })

  it.each([
    ['replace', { op: 'replace', block_id: 'b2', markdown: 'x' }],
    ['delete', { op: 'delete', block_id: 'b4' }],
    ['insert_after', { op: 'insert_after', block_id: 'b4', markdown: 'x' }],
    ['insert_before', { op: 'insert_before', block_id: 'b2', markdown: 'x' }],
  ])('blocks scope: rejects %s outside the targets', (_name, op) => {
    expect(validateOps(result({ ops: [op] }), blocks)[0]).toContain('outside the target blocks')
  })

  it('rejects a block id that is not in the snapshot', () => {
    const errors = validateOps(result({ ops: [{ op: 'delete', block_id: 'b99' }] }), blocks)
    expect(errors[0]).toContain('no such block')
  })

  it('rejects two replacements (or a replace and a delete) of one block', () => {
    const errors = validateOps(
      result({
        ops: [
          { op: 'replace', block_id: 'b3', markdown: 'x' },
          { op: 'delete', block_id: 'b3' },
        ],
      }),
      blocks,
    )
    expect(errors[0]).toContain('only once')
  })

  it.each([
    [
      'delete then insert_after',
      [
        { op: 'delete', block_id: 'b3' },
        { op: 'insert_after', block_id: 'b3', markdown: 'New' },
      ],
    ],
    [
      'insert_before then delete',
      [
        { op: 'insert_before', block_id: 'b3', markdown: 'New' },
        { op: 'delete', block_id: 'b3' },
      ],
    ],
  ])('rejects an insert anchored on a block the same result deletes (%s)', (_name, ops) => {
    const errors = validateOps(result({ ops }), blocks)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('deleted by another op')
  })

  it('rejects a replace with empty markdown, and an insert anchored on it', () => {
    const errors = validateOps(
      result({
        ops: [
          { op: 'replace', block_id: 'b3', markdown: ' \n' },
          { op: 'insert_after', block_id: 'b3', markdown: 'New' },
        ],
      }),
      blocks,
    )
    expect(errors.join('\n')).toContain('replacement markdown is empty')
    expect(errors.join('\n')).toContain('deleted by another op')
  })

  it('rejects an empty insertion', () => {
    const errors = validateOps(
      result({ ops: [{ op: 'insert_after', block_id: 'b3', markdown: ' \n' }] }),
      blocks,
    )
    expect(errors[0]).toContain('empty')
  })

  it('article scope may touch any content block but not the front matter', () => {
    const context = { scope: 'article' as const, targets: ['b2', 'b3', 'b4'], snapshot }
    expect(validateOps(result({ ops: [{ op: 'delete', block_id: 'b4' }] }), context)).toEqual([])
    expect(validateOps(result({ ops: [{ op: 'delete', block_id: 'b1' }] }), context)[0]).toContain(
      'front matter',
    )
  })

  it('research scope must not edit', () => {
    const context = { scope: 'research' as const, targets: [], snapshot }
    expect(validateOps(result({ notes: 'answer' }), context)).toEqual([])
    expect(validateOps(result({ ops: [{ op: 'delete', block_id: 'b2' }] }), context)[0]).toContain(
      'research',
    )
  })

  it('b0 lets an insert create first content, only in a document without content', () => {
    const empty: Snapshot = { blocks: [], gaps: [''] }
    const draft = result({ ops: [{ op: 'insert_after', block_id: 'b0', markdown: '# Draft' }] })
    expect(validateOps(draft, { scope: 'article', targets: ['b0'], snapshot: empty })).toEqual([])
    expect(validateOps(draft, { scope: 'article', targets: [], snapshot })[0]).toContain('b0')
    const wrong = result({ ops: [{ op: 'replace', block_id: 'b0', markdown: 'x' }] })
    expect(validateOps(wrong, { scope: 'article', targets: ['b0'], snapshot: empty })[0]).toContain(
      'insert_after',
    )
  })

  it.each([
    '/etc/passwd',
    'assets/../../x.png',
    '../x.png',
    'assets/',
    'diagram.png',
    'assets/a b.png',
  ])('rejects the asset path %j', (file) => {
    expect(validateOps(result({ assets: [{ file }] }), blocks)[0]).toContain('inside assets/')
  })

  it('sends b0 only when a request has no target that exists', () => {
    const frontMatterOnly: Snapshot = {
      blocks: [{ id: 'b1', raw: '---\ntitle: x\n---', kind: 'frontmatter' }],
      gaps: ['', '\n'],
    }
    // A job on the front matter itself keeps its target…
    expect(effectiveTargets('blocks', ['b1'], frontMatterOnly)).toEqual(['b1'])
    const edit = result({
      ops: [{ op: 'replace', block_id: 'b1', markdown: '---\ntitle: y\n---' }],
    })
    expect(
      validateOps(edit, { scope: 'blocks', targets: ['b1'], snapshot: frontMatterOnly }),
    ).toEqual([])
    // …a draft into the empty body gets the start anchor…
    expect(effectiveTargets('article', [], frontMatterOnly)).toEqual(['b0'])
    expect(effectiveTargets('article', [], { blocks: [], gaps: [''] })).toEqual(['b0'])
    // …and a document with content, or a research job, is left alone.
    expect(effectiveTargets('blocks', ['b3'], snapshot)).toEqual(['b3'])
    expect(effectiveTargets('research', [], frontMatterOnly)).toEqual([])
  })

  it('rejects a declared asset that no op references', () => {
    const errors = validateOps(
      result({
        ops: [{ op: 'insert_after', block_id: 'b3', markdown: 'See the diagram.' }],
        assets: [{ file: 'assets/d.png' }],
      }),
      blocks,
    )
    expect(errors[0]).toContain('declared but no op references it')
  })

  it('accepts nested asset paths and rejects duplicates', () => {
    const referenced = {
      ops: [
        {
          op: 'insert_after',
          block_id: 'b3',
          markdown: '![a](assets/img/a.png) ![b](assets/a.png)',
        },
      ],
    }
    expect(
      validateOps(result({ ...referenced, assets: [{ file: 'assets/img/a.png' }] }), blocks),
    ).toEqual([])
    const twice = result({
      ...referenced,
      assets: [{ file: 'assets/a.png' }, { file: 'assets/a.png' }],
    })
    expect(validateOps(twice, blocks)[0]).toContain('twice')
  })

  it('reports a malformed asset path once, and not also as unreferenced or listed twice', () => {
    const errors = validateOps(
      result({
        ops: [{ op: 'insert_after', block_id: 'b3', markdown: 'See the diagram.' }],
        assets: [{ file: '../d.png' }, { file: '../d.png' }, { file: 'assets/ok.png' }],
      }),
      blocks,
    )
    expect(errors).toEqual([
      'assets[0]: "../d.png" must be a plain path inside assets/',
      'assets[1]: "../d.png" must be a plain path inside assets/',
      'asset "assets/ok.png" is declared but no op references it as `assets/ok.png`',
    ])
  })
})

describe('op application', () => {
  const apply = (
    ops: Op[],
    accepted: number[],
    prior: Record<number, string[]> = {},
    base = setup(),
  ) =>
    applyOps(
      base.doc,
      accepted.map((index) => ({ index, op: ops[index] as Op })),
      ops,
      prior,
      base.mint,
    )
  /** Accept one op at a time in `order`, handing each step where the earlier inserts landed. */
  const acceptInOrder = (ops: Op[], order: number[]) => {
    const base = setup()
    let doc = base.doc
    let prior: Record<number, string[]> = {}
    for (const index of order) {
      const step = apply(ops, [index], prior, { doc, mint: base.mint })
      doc = step.doc
      prior = { ...prior, ...step.inserted }
    }
    return doc
  }

  it('replaces, inserts and deletes against the live document', () => {
    const ops: Op[] = [
      { op: 'replace', block_id: 'b2', markdown: 'B2' },
      { op: 'insert_after', block_id: 'b2', markdown: 'X\n\nY' },
      { op: 'insert_before', block_id: 'b1', markdown: 'Top' },
      { op: 'delete', block_id: 'b3' },
    ]
    const { doc, missing } = apply(ops, [0, 1, 2, 3])
    expect(serialise(doc)).toBe('Top\n\nA\n\nB2\n\nX\n\nY\n')
    expect(missing).toEqual([])
  })

  it('applies only the accepted ops', () => {
    const ops: Op[] = [
      { op: 'replace', block_id: 'b1', markdown: 'A2' },
      { op: 'delete', block_id: 'b3' },
    ]
    expect(serialise(apply(ops, [0]).doc)).toBe('A2\n\nB\n\nC\n')
  })

  it('keeps the result order of several inserts at one anchor, whatever the accept order', () => {
    const ops: Op[] = [
      { op: 'insert_after', block_id: 'b1', markdown: 'one' },
      { op: 'insert_after', block_id: 'b1', markdown: 'two' },
      { op: 'insert_after', block_id: 'b1', markdown: 'three' },
    ]
    expect(serialise(acceptInOrder(ops, [2, 0, 1]))).toBe('A\n\none\n\ntwo\n\nthree\n\nB\n\nC\n')
  })

  it('keeps the result order for insert_before as well', () => {
    const ops: Op[] = [
      { op: 'insert_before', block_id: 'b2', markdown: 'one' },
      { op: 'insert_before', block_id: 'b2', markdown: 'two' },
    ]
    expect(serialise(acceptInOrder(ops, [1, 0]))).toBe('A\n\none\n\ntwo\n\nB\n\nC\n')
    expect(serialise(apply(ops, [0, 1]).doc)).toBe('A\n\none\n\ntwo\n\nB\n\nC\n')
  })

  it('reports an op whose target is gone instead of guessing a position', () => {
    const ops: Op[] = [{ op: 'replace', block_id: 'b9', markdown: 'x' }]
    const { doc, missing } = apply(ops, [0])
    expect(missing).toEqual([0])
    expect(serialise(doc)).toBe('A\n\nB\n\nC\n')
  })

  it('b0 inserts into an empty document', () => {
    const ops: Op[] = [{ op: 'insert_after', block_id: 'b0', markdown: '# Draft\n\nBody' }]
    expect(serialise(apply(ops, [0], {}, setup('')).doc)).toBe('# Draft\n\nBody\n')
  })

  it('b0 inserts below the front matter', () => {
    const ops: Op[] = [{ op: 'insert_after', block_id: 'b0', markdown: 'Body' }]
    expect(serialise(apply(ops, [0], {}, setup('---\nt: 1\n---\n')).doc)).toBe(
      '---\nt: 1\n---\n\nBody\n',
    )
  })
})

describe('queueing and conflict rules', () => {
  const claim = (
    id: string,
    scope: Claim['scope'],
    targets: string[],
    docKey = 'article:a',
  ): Claim => ({
    id,
    docKey,
    scope,
    targets,
  })

  it('jobs on different blocks run at once', () => {
    expect(blockersOf(claim('j2', 'blocks', ['b2']), [claim('j1', 'blocks', ['b1'])])).toEqual([])
  })

  it('a second job on a busy block queues behind the first', () => {
    expect(
      blockersOf(claim('j2', 'blocks', ['b1', 'b2']), [claim('j1', 'blocks', ['b2'])]),
    ).toEqual(['j1'])
  })

  it('it starts only when the first is settled, not when its process ends', () => {
    const held = [claim('j2', 'blocks', ['b1'])]
    // j1 finished (state "ready") but is unreviewed: still in `unsettled`, still blocking.
    expect(startable(held, [claim('j1', 'blocks', ['b1'])])).toEqual([])
    // Accepted or rejected: gone from `unsettled`, so j2 runs against the outcome.
    expect(startable(held, [])).toEqual(held)
  })

  it('an article job waits for every running edit job in its document', () => {
    expect(blockersOf(claim('art', 'article', []), [claim('j1', 'blocks', ['b7'])])).toEqual(['j1'])
  })

  it('new block jobs queue behind a waiting article job (FIFO barrier)', () => {
    const held = [claim('art', 'article', []), claim('j3', 'blocks', ['b9'])]
    const unsettled = [claim('j1', 'blocks', ['b1'])]
    expect(startable(held, unsettled)).toEqual([])
    expect(startable(held, []).map((c) => c.id)).toEqual(['art'])
  })

  it('new block jobs queue behind a running article job', () => {
    expect(blockersOf(claim('j3', 'blocks', ['b9']), [claim('art', 'article', [])])).toEqual([
      'art',
    ])
  })

  it('an article job does not block other documents', () => {
    const other = claim('j3', 'blocks', ['b1'], 'article:b')
    expect(blockersOf(other, [claim('art', 'article', [])])).toEqual([])
  })

  it('research never waits and nobody waits for it', () => {
    expect(blockersOf(claim('r', 'research', []), [claim('art', 'article', [])])).toEqual([])
    expect(blockersOf(claim('art', 'article', []), [claim('r', 'research', [])])).toEqual([])
  })

  it('held requests keep their order among themselves', () => {
    const held = [
      claim('h1', 'blocks', ['b1']),
      claim('h2', 'blocks', ['b1']),
      claim('h3', 'blocks', ['b2']),
    ]
    expect(startable(held, []).map((c) => c.id)).toEqual(['h1', 'h3'])
  })

  it('a deleted target makes the job stale', () => {
    expect(missingTargets(['b1', 'b2'], ['b2', 'b3'])).toEqual(['b1'])
    expect(missingTargets(['b0'], [])).toEqual([])
  })

  it('only a blocks job goes stale when a target disappears', () => {
    // A Backspace merge removes one id: b4 is gone.
    const after = ['b1', 'b2', 'b3']
    expect(lostItsTargets('blocks', ['b3', 'b4'], after)).toBe(true)
    expect(lostItsTargets('blocks', ['b2', 'b3'], after)).toBe(false)
    // A whole-article draft lists every block as a target; an ordinary edit must not cancel it.
    expect(lostItsTargets('article', ['b2', 'b3', 'b4'], after)).toBe(false)
    expect(lostItsTargets('research', [], after)).toBe(false)
  })

  it('an edit during the job is flagged as changed since request', () => {
    expect(changedSinceRequest({ b1: 'before' }, 'b1', 'after')).toBe(true)
    expect(changedSinceRequest({ b1: 'same' }, 'b1', 'same')).toBe(false)
    expect(changedSinceRequest({}, 'b9', 'new block')).toBe(false)
  })
})

describe('asset references', () => {
  const map = { 'assets/diagram.png': 'diagram-2.png' }

  it('rewrites image and link destinations, HTML attributes and shortcode parameters', () => {
    const markdown = [
      '![alt](assets/diagram.png)',
      '![alt](assets/diagram.png "Title")',
      '[cast](<assets/diagram.png>)',
      '<img src="assets/diagram.png">',
      '{{< figure src="assets/diagram.png" >}}',
      '{{< img "assets/diagram.png" >}}',
    ].join('\n')
    expect(rewriteAssetRefs(markdown, map)).toBe(
      [
        '![alt](diagram-2.png)',
        '![alt](diagram-2.png "Title")',
        '[cast](<diagram-2.png>)',
        '<img src="diagram-2.png">',
        '{{< figure src="diagram-2.png" >}}',
        '{{< img "diagram-2.png" >}}',
      ].join('\n'),
    )
  })

  it('treats a leading ./ and reference-style definitions as the same path', () => {
    const markdown = [
      '![a](./assets/diagram.png)',
      '![b][img]',
      '',
      '[img]: assets/diagram.png "Title"',
      '[cast]: <./assets/diagram.png>',
    ].join('\n')
    expect(referencedAssets(markdown, ['assets/diagram.png'])).toEqual(['assets/diagram.png'])
    expect(rewriteAssetRefs(markdown, map)).toBe(
      [
        '![a](diagram-2.png)',
        '![b][img]',
        '',
        '[img]: diagram-2.png "Title"',
        '[cast]: <diagram-2.png>',
      ].join('\n'),
    )
  })

  it('leaves prose and longer paths alone', () => {
    const markdown = 'See assets/diagram.png in the text, and ![x](assets/diagram.png.bak).'
    expect(rewriteAssetRefs(markdown, map)).toBe(markdown)
  })

  it('finds which assets an op references', () => {
    const files = ['assets/a.png', 'assets/b.gif']
    expect(referencedAssets('![a](assets/a.png)', files)).toEqual(['assets/a.png'])
    expect(referencedAssets('no refs, just the word assets/b.gif', files)).toEqual([])
  })
})
