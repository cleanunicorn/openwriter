import {
  type AppState,
  bumpThemeEpoch,
  createArticle,
  openDoc,
  saveConfigPatch,
  setPalette,
} from '../state/app.ts'

import type { Command } from './group.ts'

export { type Command, type CommandGroup, filterCommands } from './group.ts'

type Provider = (state: AppState) => Command[]
const providers: Provider[] = []

/** Feature modules add commands to this registry; the palette only lists and runs them. */
export const registerCommands = (provider: Provider) => {
  providers.push(provider)
}

const THEMES = ['system', 'light', 'dark'] as const

export function applyTheme(theme: (typeof THEMES)[number]): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  bumpThemeEpoch()
}

function setTheme(theme: (typeof THEMES)[number]): Promise<void> {
  applyTheme(theme)
  return saveConfigPatch({ theme }, 'The theme is set for now, but could not be saved')
}

registerCommands((state) => {
  const theme = state.config?.config.theme ?? 'system'
  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system'
  return [
    ...state.articles.map((article) => ({
      id: `open:${article.slug}`,
      title: `Open article: ${article.title}`,
      hint: article.slug,
      group: 'documents' as const,
      run: () => openDoc({ kind: 'article', slug: article.slug }),
    })),
    {
      id: 'new-article',
      title: 'New article…',
      group: 'documents',
      run: () =>
        setPalette({
          kind: 'input',
          label: 'Article title',
          placeholder: 'Title of the new article',
          submit: (title) => void createArticle(title),
        }),
    },
    {
      id: 'theme',
      title: `Theme: switch to ${nextTheme}`,
      hint: `now ${theme}`,
      group: 'app',
      run: () => setTheme(nextTheme),
    },
  ]
})

export const allCommands = (state: AppState): Command[] =>
  providers.flatMap((provider) => provider(state))
