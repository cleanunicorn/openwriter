import { api } from '../api.ts'
import {
  type AppState,
  bumpThemeEpoch,
  createArticle,
  notifyFailure,
  openDoc,
  setPalette,
  store,
} from '../state/app.ts'

export type Command = { id: string; title: string; hint?: string; run: () => void | Promise<void> }

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

async function setTheme(theme: (typeof THEMES)[number]): Promise<void> {
  applyTheme(theme)
  const current = store.get().config
  if (current === null || current.error !== null) return
  // Update the store first: the next toggle must see this theme even if the save is still in flight.
  const config = { ...current.config, theme }
  store.set((state) => ({ ...state, config: { ...current, config } }))
  try {
    await api.saveConfig(config)
  } catch (error) {
    notifyFailure('The theme is set for now, but could not be saved', error)
  }
}

registerCommands((state) => {
  const theme = state.config?.config.theme ?? 'system'
  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system'
  return [
    ...state.articles.map((article) => ({
      id: `open:${article.slug}`,
      title: `Open article: ${article.title}`,
      hint: article.slug,
      run: () => openDoc({ kind: 'article', slug: article.slug }),
    })),
    {
      id: 'new-article',
      title: 'New article…',
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
      run: () => setTheme(nextTheme),
    },
  ]
})

export const allCommands = (state: AppState): Command[] =>
  providers.flatMap((provider) => provider(state))

/** Every word of the query must appear in the title or the hint, in any order. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((command) => {
    const haystack = `${command.title} ${command.hint ?? ''}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}
