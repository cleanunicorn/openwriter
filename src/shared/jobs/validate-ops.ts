import { referencedAssets } from './asset-refs.ts'
import type { Scope, Snapshot } from './job-types.ts'
import type { Result } from './result-schema.ts'

/** Virtual start anchor: lets an ordinary `insert_after` create the first content of a document. */
export const START_ANCHOR = 'b0'

export const hasContent = (snapshot: Snapshot): boolean =>
  snapshot.blocks.some((block) => block.kind === 'content')

/**
 * The targets a request is really sent with. The start anchor stands in only when the request
 * has no target that exists: a job aimed at the front matter of an article without a body keeps
 * its target (it would otherwise be rejected as "outside the target blocks" after two paid runs).
 */
export function effectiveTargets(scope: Scope, targets: string[], snapshot: Snapshot): string[] {
  if (scope === 'research') return targets
  const ids = new Set(snapshot.blocks.map((block) => block.id))
  if (targets.some((target) => ids.has(target))) return targets
  return hasContent(snapshot) ? targets : [START_ANCHOR]
}

export type ValidationContext = { scope: Scope; targets: string[]; snapshot: Snapshot }

const ASSET_PATH = /^assets\/(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/**
 * Semantic checks on a schema-valid result. Agent output is untrusted: a well-formed op that
 * reaches outside the job's scope is rejected just like malformed JSON. Returns error messages;
 * an empty list means the result may be shown for review.
 */
export function validateOps(result: Result, context: ValidationContext): string[] {
  const errors: string[] = []
  const { scope, snapshot } = context
  const targets = new Set(context.targets)
  const kinds = new Map(snapshot.blocks.map((block) => [block.id, block.kind]))
  const anchorAllowed = !hasContent(snapshot)

  if (scope === 'research' && result.ops.length > 0) {
    errors.push('research jobs must not contain ops; put the answer in "notes"')
  }

  // An insert anchored on a block that the same result removes would lose its anchor when the ops
  // are applied, and the new text would silently vanish. "Replace this section" is one `replace`.
  const removed = new Set(
    result.ops
      .filter((op) => op.op === 'delete' || (op.op === 'replace' && op.markdown.trim() === ''))
      .map((op) => op.block_id),
  )
  const edited = new Set<string>()
  result.ops.forEach((op, index) => {
    const where = `ops[${index}] (${op.op} ${op.block_id})`
    const isInsert = op.op === 'insert_after' || op.op === 'insert_before'
    if (op.block_id === START_ANCHOR) {
      if (!anchorAllowed)
        errors.push(`${where}: ${START_ANCHOR} exists only in a document without content`)
      else if (op.op !== 'insert_after')
        errors.push(`${where}: only insert_after may use ${START_ANCHOR}`)
    } else if (!kinds.has(op.block_id)) {
      errors.push(`${where}: no such block in article.md`)
      return
    }
    if (scope === 'blocks' && !targets.has(op.block_id)) {
      errors.push(`${where}: outside the target blocks (${[...targets].join(', ')})`)
    }
    if (kinds.get(op.block_id) === 'frontmatter' && !targets.has(op.block_id)) {
      errors.push(`${where}: the front matter may only be changed when it is a target`)
    }
    if (op.op === 'replace' || op.op === 'delete') {
      if (edited.has(op.block_id))
        errors.push(`${where}: a block may be replaced or deleted only once`)
      edited.add(op.block_id)
    }
    if (isInsert && op.markdown.trim() === '') {
      errors.push(`${where}: inserted markdown is empty`)
    }
    if (op.op === 'replace' && op.markdown.trim() === '') {
      errors.push(`${where}: replacement markdown is empty; use a delete op to remove a block`)
    }
    if (isInsert && removed.has(op.block_id)) {
      errors.push(
        `${where}: block ${op.block_id} is deleted by another op in this result; use one replace op, or anchor the insert on a block that stays`,
      )
    }
  })

  const seen = new Set<string>()
  result.assets.forEach((asset, index) => {
    if (!ASSET_PATH.test(asset.file)) {
      errors.push(`assets[${index}]: "${asset.file}" must be a plain path inside assets/`)
    } else if (seen.has(asset.file)) {
      errors.push(`assets[${index}]: "${asset.file}" is listed twice`)
    }
    seen.add(asset.file)
  })

  // A declared asset that no op references would never be copied into the bundle, and a
  // reference the matcher cannot see would stay `assets/…` — a dead link in the article.
  const markdown = result.ops.map((op) => (op.op === 'delete' ? '' : op.markdown)).join('\n\n')
  for (const file of seen) {
    if (ASSET_PATH.test(file) && referencedAssets(markdown, [file]).length === 0) {
      errors.push(`asset "${file}" is declared but no op references it as \`${file}\``)
    }
  }
  return errors
}
