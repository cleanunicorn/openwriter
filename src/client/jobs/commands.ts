import type { DocRef } from '../../shared/api-types.ts'
import type { Scope } from '../../shared/jobs/job-types.ts'
import { registerCommands } from '../palette/commands.ts'
import { currentDoc, setPalette } from '../state/app.ts'
import { requestJob, setTrayOpen } from '../state/jobs.ts'

/** Ask for an instruction in the palette, then start an ordinary job with it. */
export function askInPalette(options: {
  label: string
  placeholder: string
  doc: DocRef
  scope: Scope
  skill?: string
  targets?: string[]
}): void {
  setPalette({
    kind: 'input',
    label: options.label,
    placeholder: options.placeholder,
    submit: (instruction) =>
      requestJob({
        doc: options.doc,
        scope: options.scope,
        instruction,
        skill: options.skill,
        targets: options.targets ?? [],
      }),
  })
}

registerCommands((state) => {
  const doc = currentDoc(state)
  if (doc === null || doc.status !== 'ready') return []
  const content = doc.doc.blocks
    .filter((block) => block.kind === 'content')
    .map((block) => block.id)
  return [
    {
      id: 'ask-article',
      title: 'Instruct the agent: whole article…',
      hint: 'article scope',
      run: () =>
        askInPalette({
          label: 'Instruction for the whole article',
          placeholder: 'Restructure, tighten, reorder…',
          doc: doc.ref,
          scope: 'article',
          targets: content,
        }),
    },
    {
      id: 'ask-research',
      title: 'Research question…',
      hint: 'no edits; answer goes to notes',
      run: () =>
        askInPalette({
          label: 'Research question',
          placeholder: 'What do my sources say about…',
          doc: doc.ref,
          scope: 'research',
        }),
    },
    { id: 'show-jobs', title: 'Show agent jobs', run: () => setTrayOpen(true) },
  ]
})
