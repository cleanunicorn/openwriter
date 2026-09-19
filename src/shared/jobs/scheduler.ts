import type { Scope } from './job-types.ts'

/** Anything that can hold or want block locks: an unsettled server job or a held request. */
export type Claim = { id: string; docKey: string; scope: Scope; targets: string[] }

/**
 * Why `candidate` cannot start yet, as the IDs of the claims ahead of it that block it.
 * `ahead` is every unsettled job plus every held request that was made earlier.
 *
 * - `research` edits nothing: it never waits and nobody waits for it.
 * - A `blocks` job waits for an earlier job that shares a target block — until that job is
 *   *settled* (accepted or rejected), not merely finished — so it runs against the outcome.
 * - An `article` job is exclusive within its document: it waits for every earlier edit job, and
 *   every later edit job waits for it (a FIFO barrier, so it cannot be starved).
 * - Other documents are never affected, and the writer's own edits never consult this at all.
 */
export function blockersOf(candidate: Claim, ahead: Claim[]): string[] {
  if (candidate.scope === 'research') return []
  return ahead
    .filter((other) => other.docKey === candidate.docKey && other.scope !== 'research')
    .filter(
      (other) =>
        other.scope === 'article' ||
        candidate.scope === 'article' ||
        other.targets.some((target) => candidate.targets.includes(target)),
    )
    .map((other) => other.id)
}

/** Held requests (oldest first) that may start now. An earlier held request is still ahead. */
export function startable(held: Claim[], unsettled: Claim[]): Claim[] {
  const ready: Claim[] = []
  held.forEach((request, index) => {
    const ahead = [...unsettled, ...held.slice(0, index)]
    if (blockersOf(request, ahead).length === 0) ready.push(request)
  })
  return ready
}

/**
 * Did the job lose what it was asked to edit? Only a `blocks` job can: its ops are confined to
 * its targets. For `article` scope the targets are just "everything that was there" — an
 * ordinary merge or delete while a long draft runs must not cancel it (ops on a vanished block
 * are reported when they are applied) — and `research` edits nothing.
 */
export function lostItsTargets(scope: Scope, targets: string[], blockIds: string[]): boolean {
  return scope === 'blocks' && missingTargets(targets, blockIds).length > 0
}

/** Targets that no longer exist in the document: the job (or held request) is stale. */
export function missingTargets(targets: string[], blockIds: string[]): string[] {
  const present = new Set(blockIds)
  return targets.filter((target) => target !== 'b0' && !present.has(target))
}

/** "Changed since request": the block's current text differs from the job's snapshot. */
export function changedSinceRequest(
  snapshotRaws: Record<string, string>,
  blockId: string,
  currentRaw: string,
): boolean {
  const before = snapshotRaws[blockId]
  return before !== undefined && before !== currentRaw
}
