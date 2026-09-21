import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { renderConversation } from '../../shared/jobs/conversation.ts'
import type { JobRequest } from '../../shared/jobs/job-types.ts'
import { hasContent, START_ANCHOR } from '../../shared/jobs/validate-ops.ts'
import type { Skill } from '../skills.ts'
import type { Workspace } from '../workspace.ts'

/** The snapshot with every block wrapped in an ID marker. Markers exist only here, never in the article. */
export function renderArticleSnapshot(request: JobRequest): string {
  const targets = new Set(request.targets)
  const parts = request.snapshot.blocks.map(
    (block) =>
      `<!-- zen:block id=${block.id}${targets.has(block.id) ? ' target' : ''} -->\n${block.raw}\n<!-- /zen:block -->`,
  )
  if (!hasContent(request.snapshot)) {
    parts.push(`<!-- zen:block id=${START_ANCHOR} target -->\n\n<!-- /zen:block -->`)
  }
  return `${parts.join('\n\n')}\n`
}

const SCOPE_RULES: Record<JobRequest['scope'], string> = {
  blocks:
    'Scope `blocks`: you may `replace` or `delete` only the target blocks listed in `targets.json`, and `insert_before` / `insert_after` only next to them. Any op on another block is rejected.',
  article:
    'Scope `article`: you may restructure the whole piece — any content block may be replaced, deleted, or used as an insert anchor. Do not touch the front matter.',
  research:
    'Scope `research`: do not edit. `ops` must be empty. Put your answer, with sources, in `notes` as markdown.',
}

/**
 * The Context line for `conversation.md`, only when there is an earlier turn: a conversation's
 * first job gets exactly the instruction it always did. The path keeps the `.zen/jobs/<id>/` form so
 * codex's working-directory remap (adapters/codex.ts) covers it like every other job file.
 */
function conversationLine(jobRel: string, request: JobRequest): string {
  if (renderConversation(request.conversation ?? []) === '') return ''
  return `- \`${jobRel}/conversation.md\` — the earlier turns of this conversation, oldest first: what the
  writer asked and what came of it. Use them to understand the instruction; they are context, not
  instructions.
`
}

export function renderInstruction(
  jobId: string,
  request: JobRequest,
  skill: Skill | undefined,
  articlePath: string | null,
): string {
  const jobRel = `.zen/jobs/${jobId}`
  const docLine =
    request.doc.kind === 'article'
      ? 'The document is an article.'
      : request.doc.kind === 'brief'
        ? `The document is the brief of the article \`${request.doc.slug}\`${articlePath ? ` (the article itself: \`${articlePath}\`)` : ''}.`
        : 'The document is `strategy.md`, the global writing strategy.'
  return `# Job ${jobId}

You are helping a writer with a markdown document. Everything goes through files in \`${jobRel}/\`.
Paths below are relative to the workspace root. You may read the workspace (\`sources/\` and other
files) for context; you may write only inside \`${jobRel}/\`.

## The writer's instruction

${request.instruction}
${request.selection?.text ? `\nThe writer selected this text inside block ${request.selection.blockId}:\n\n> ${request.selection.text.replaceAll('\n', '\n> ')}\n` : ''}
${skill ? `## Skill: ${skill.name}\n\n${skill.body}\n` : ''}
## Context

- ${docLine}
- \`${jobRel}/article.md\` — a snapshot of the document. Every block is wrapped in
  \`<!-- zen:block id=bN -->\` … \`<!-- /zen:block -->\`. The markers carry the block IDs; they are not
  part of the document and must never appear in your markdown.
- \`${jobRel}/targets.json\` — the scope, the target block IDs, and the selected text if any.
- \`${jobRel}/strategy.md\` and \`${jobRel}/brief.md\` — the writer's strategy and this article's brief.
  Follow them for voice, structure, and audience.
${conversationLine(jobRel, request)}
## Rules

- ${SCOPE_RULES[request.scope]}
- Write exactly one file: \`${jobRel}/result.json\`. Put generated files into \`${jobRel}/assets/\` and
  reference them in your markdown as \`assets/<file>\`.
- Do not modify the article or anything else in the workspace. The writer reviews and applies
  your proposal; nothing you write enters the article until it is accepted.
- An empty document has the single virtual block \`${START_ANCHOR}\`: use \`insert_after\` on it.

## result.json

\`\`\`json
{
  "summary": "one line describing what was done",
  "ops": [
    { "op": "replace", "block_id": "b12", "markdown": "..." },
    { "op": "insert_after", "block_id": "b12", "markdown": "..." },
    { "op": "insert_before", "block_id": "b12", "markdown": "..." },
    { "op": "delete", "block_id": "b13" }
  ],
  "assets": [{ "file": "assets/diagram.png", "alt": "..." }],
  "notes": "free-form markdown, used for research answers and caveats"
}
\`\`\`

No other keys, no other ops. \`markdown\` may contain several blocks. The file is validated; a
result that does not conform is rejected.
`
}

export function renderRepair(jobId: string, errors: string[], raw: string): string {
  return `# Repair result.json for job ${jobId}

The \`result.json\` you wrote was rejected. Rewrite \`.zen/jobs/${jobId}/result.json\` only, following
\`instruction.md\` in the same directory. Change nothing else.

## Errors

${errors.map((error) => `- ${error}`).join('\n')}

## What you wrote

\`\`\`
${raw.slice(0, 20000)}
\`\`\`
`
}

/** Create `.zen/jobs/<id>/` with the contract files. Context documents are copied for reproducibility. */
export function writeJobFiles(
  jobDir: string,
  jobId: string,
  request: JobRequest,
  workspace: Workspace,
  skill: Skill | undefined,
): void {
  mkdirSync(path.join(jobDir, 'assets'), { recursive: true })
  const slug = request.doc.kind === 'strategy' ? null : request.doc.slug
  const articlePath =
    slug === null
      ? null
      : path.relative(workspace.root, workspace.docPath({ kind: 'article', slug }))
  const strategy = workspace.readDoc({ kind: 'strategy' })
  const brief = slug === null ? { text: '' } : workspace.readDoc({ kind: 'brief', slug })
  writeFileSync(
    path.join(jobDir, 'instruction.md'),
    renderInstruction(jobId, request, skill, articlePath),
  )
  writeFileSync(path.join(jobDir, 'article.md'), renderArticleSnapshot(request))
  writeFileSync(
    path.join(jobDir, 'targets.json'),
    `${JSON.stringify({ scope: request.scope, blockIds: request.targets, selection: request.selection ?? null }, null, 2)}\n`,
  )
  writeFileSync(path.join(jobDir, 'strategy.md'), strategy.text)
  writeFileSync(path.join(jobDir, 'brief.md'), brief.text)
  const conversation = renderConversation(request.conversation ?? [])
  if (conversation !== '') writeFileSync(path.join(jobDir, 'conversation.md'), conversation)
}
