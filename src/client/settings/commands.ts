import type { DocRef } from '../../shared/api-types.ts'
import { registerCommands } from '../palette/commands.ts'
import { type AppState, currentDoc, openDoc, setPanel, store } from '../state/app.ts'
import { requestJob } from '../state/jobs.ts'

const slugOf = (state: AppState): string | null => {
  const ref = state.current
  return ref === null || ref.kind === 'strategy' ? (state.articles[0]?.slug ?? null) : ref.slug
}

/** "Draft …" is an ordinary job: open the destination document, then ask for the whole of it. */
async function draft(ref: DocRef, skill: string, instruction: string): Promise<void> {
  await openDoc(ref)
  const doc = currentDoc(store.get())
  if (doc === null || doc.status !== 'ready') return
  const targets = doc.doc.blocks
    .filter((block) => block.kind === 'content')
    .map((block) => block.id)
  requestJob({ doc: ref, scope: 'article', instruction, skill, targets })
}

registerCommands((state) => {
  const slug = slugOf(state)
  const commands = [
    {
      id: 'settings',
      title: 'Settings…',
      hint: 'agents, content directory, theme',
      run: () => setPanel('settings'),
    },
    {
      id: 'edit-strategy',
      title: 'Edit strategy',
      hint: 'strategy.md',
      run: () => openDoc({ kind: 'strategy' }),
    },
  ]
  if (slug === null) return commands
  return [
    ...commands,
    {
      id: 'edit-brief',
      title: 'Edit brief',
      hint: `brief for ${slug}`,
      run: () => openDoc({ kind: 'brief', slug }),
    },
    {
      id: 'draft-brief',
      title: 'Draft brief from my notes',
      hint: 'a job; you review the result',
      run: () =>
        draft(
          { kind: 'brief', slug },
          'draft-brief',
          'Draft the brief for this article from my notes in sources/.',
        ),
    },
    {
      id: 'draft-article',
      title: 'Draft article from brief',
      hint: 'a job; you review the result',
      run: () =>
        draft({ kind: 'article', slug }, 'draft-article', 'Draft the article from its brief.'),
    },
  ]
})
