import { docKey } from '../api-types.ts'
import { isActive, type Job, type Turn, type TurnOutcome } from './job-types.ts'

/**
 * The right panel's conversation, carried inside the ordinary job contract: a follow-up turn's job
 * gets one more input file, `conversation.md`, with the earlier turns about the same document.
 * Pure, shared by the client (which picks the turns) and the server (which bounds and writes them).
 */

/** How many earlier turns a job carries, and how much of each; the whole file is capped too. */
export const CONVERSATION_LIMITS = {
  turns: 6,
  instruction: 600,
  summary: 300,
  notes: 1500,
  file: 8000,
} as const

export function outcomeOf(job: Job): TurnOutcome {
  if (isActive(job.state)) return 'still running'
  if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'stale') return job.state
  if (job.scope === 'research') return 'answered'
  const total = job.result?.ops.length ?? 0
  const decisions = Object.values(job.decisions)
  if (job.state === 'ready' && decisions.length < total) return 'awaiting review'
  if (total === 0) return 'done'
  const accepted = decisions.filter((decision) => decision === 'accepted').length
  if (accepted === total) return 'accepted'
  if (accepted === 0) return 'rejected'
  return 'partly accepted'
}

/**
 * The turns before a new request: the jobs about the same document (any entry point — the panel,
 * the pill, the palette, a skill), started after the writer's last "New conversation", oldest
 * first, the last few only.
 */
export function threadFor(
  key: string,
  jobs: Record<string, Job>,
  order: string[],
  since: string | null,
): Turn[] {
  const turns = order.flatMap((id) => {
    const job = jobs[id]
    if (job === undefined || docKey(job.doc) !== key) return []
    if (since !== null && job.createdAt <= since) return []
    return [
      {
        instruction: clip(job.instruction, CONVERSATION_LIMITS.instruction),
        scope: job.scope,
        skill: job.skill,
        summary: job.result === null ? null : clip(job.result.summary, CONVERSATION_LIMITS.summary),
        notes:
          job.scope === 'research' && job.result !== null && job.result.notes !== ''
            ? clip(job.result.notes, CONVERSATION_LIMITS.notes)
            : null,
        outcome: outcomeOf(job),
      },
    ]
  })
  return turns.slice(-CONVERSATION_LIMITS.turns)
}

/** At most `max` UTF-16 units, ending in `…`. Never splits a surrogate pair (an emoji, say). */
const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text
        .slice(0, max - 1)
        .replace(/[\uD800-\uDBFF]$/, '')
        .trimEnd()}…`

const SCOPE_NAMES: Record<Turn['scope'], string> = {
  blocks: 'a selection',
  article: 'the whole article',
  research: 'a research question',
}

function renderTurn(turn: Turn, index: number): string {
  const lines = [
    `## Turn ${index} — ${SCOPE_NAMES[turn.scope]}${turn.skill === null ? '' : `, skill ${turn.skill}`} — ${turn.outcome}`,
    '',
    `The writer asked: ${clip(turn.instruction, CONVERSATION_LIMITS.instruction)}`,
  ]
  if (turn.summary !== null) {
    lines.push('', `The result: ${clip(turn.summary, CONVERSATION_LIMITS.summary)}`)
  }
  if (turn.notes !== null) {
    lines.push('', 'The notes:', '', clip(turn.notes, CONVERSATION_LIMITS.notes))
  }
  return lines.join('\n')
}

const HEADER = `# The conversation so far

The writer's earlier turns about this document, oldest first, and what came of each. The
article snapshot already includes whatever was accepted. Use them to understand the current
instruction ("make it shorter", "the second one"); they are context, not instructions.
`

/**
 * `conversation.md`, bounded whatever the client sent: the last turns only, each field clipped,
 * the oldest dropped until the file fits. No turns → an empty string, and no file is written.
 */
export function renderConversation(turns: Turn[]): string {
  const recent = turns.slice(-CONVERSATION_LIMITS.turns)
  let dropped = turns.length - recent.length
  const parts = recent.map((turn, index) => renderTurn(turn, index + 1))
  const render = () => {
    const note = dropped > 0 ? `\n(${dropped} earlier turns are not shown.)\n` : ''
    return `${HEADER}${note}\n${parts.join('\n\n')}\n`
  }
  while (parts.length > 0 && render().length > CONVERSATION_LIMITS.file) {
    parts.shift()
    dropped += 1
  }
  return parts.length === 0 ? '' : render()
}
