import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { Config } from '../../shared/config-schema.ts'
import { ApiError } from '../api.ts'
import { applyTheme } from '../palette/commands.ts'
import { refreshArticles, refreshConfig, saveSettings, setPanel, useApp } from '../state/app.ts'
import { useRestoreFocus } from '../use-restore-focus.ts'

const TASKS = ['image'] as const
const words = (text: string) => text.split(/\s+/).filter(Boolean)

/** Settings live in `<workspace>/.zen/config.json`; this is a form over that file, nothing more. */
export function Settings() {
  const loaded = useApp((state) => state.config)
  const [draft, setDraft] = useState<Config | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const ready = loaded !== null && draft !== null
  useRestoreFocus()

  // A modal dialog: the first control gets the keyboard when the form appears.
  useEffect(() => {
    if (ready) form.current?.querySelector<HTMLElement>('select, input')?.focus()
  }, [ready])

  // Seed the form once per opening. `state.config` is replaced by every settings event and theme
  // switch; re-seeding on each would wipe what the writer has typed so far.
  useEffect(() => {
    if (loaded !== null) setDraft((current) => current ?? loaded.config)
  }, [loaded])

  if (loaded === null || draft === null) return null
  const set = (patch: Partial<Config>) => {
    setDraft({ ...draft, ...patch })
    // "Saved." describes the last save, not a form that has been edited since.
    setMessage(null)
  }
  const adapterNames = loaded.adapters
  const setAdapter = (name: string, patch: Partial<Config['adapters'][string]>) =>
    set({
      adapters: { ...draft.adapters, [name]: { extraArgs: [], ...draft.adapters[name], ...patch } },
    })

  const save = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await saveSettings(draft)
      applyTheme(draft.theme)
      await Promise.all([refreshConfig(), refreshArticles()])
      setMessage('Saved.')
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Could not save the settings.')
    }
  }

  const close = () => setPanel(null)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab' || form.current === null) return
    // Keep Tab inside the dialog.
    const focusable = [
      ...form.current.querySelectorAll<HTMLElement>('button, select, input'),
    ].filter((element) => !element.hasAttribute('disabled'))
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return (
    <div
      className="palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={close}
      onKeyDown={onKeyDown}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the backdrop click */}
      <form
        ref={form}
        className="settings"
        aria-label="Settings"
        onSubmit={save}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="link" onClick={close}>
            Close
          </button>
        </header>
        {loaded.error !== null && (
          <p className="notice" role="alert">
            .zen/config.json is invalid, so defaults are in use and nothing will be overwritten:{' '}
            {loaded.error}
          </p>
        )}
        {loaded.adapterOverride !== null && (
          <p className="notice">
            This session was started with --adapter {loaded.adapterOverride}; it overrides the main
            agent until the app restarts.
          </p>
        )}

        <label>
          Main agent
          <select
            aria-label="Main agent"
            value={draft.mainAgent}
            onChange={(event) => set({ mainAgent: event.target.value })}
          >
            {adapterNames.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        {TASKS.map((task) => (
          <label key={task}>
            Agent for {task} tasks
            <select
              aria-label={`Agent for ${task} tasks`}
              value={draft.taskAgents[task] ?? ''}
              onChange={(event) => {
                const { [task]: _removed, ...rest } = draft.taskAgents
                set({
                  taskAgents:
                    event.target.value === '' ? rest : { ...rest, [task]: event.target.value },
                })
              }}
            >
              <option value="">same as the main agent</option>
              {adapterNames.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
        ))}
        <label>
          Content directory
          <input
            value={draft.contentDir}
            onChange={(event) => set({ contentDir: event.target.value })}
          />
        </label>
        {loaded.contentDirError !== null && (
          <p className="notice" role="alert">
            {loaded.contentDirError}
          </p>
        )}
        {loaded.contentOutsideWorkspace && (
          <p className="notice">
            The content directory is outside the workspace: articles are read and written there
            directly.
          </p>
        )}
        <label>
          Theme
          <select
            aria-label="Theme"
            value={draft.theme}
            onChange={(event) => set({ theme: event.target.value as Config['theme'] })}
          >
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
        <label>
          Jobs running at once
          <input
            type="number"
            min={1}
            max={16}
            value={draft.concurrency}
            onChange={(event) => set({ concurrency: Number(event.target.value) })}
          />
        </label>
        <label>
          Job timeout (seconds)
          <input
            type="number"
            min={1}
            max={7200}
            value={draft.jobTimeoutSec}
            onChange={(event) => set({ jobTimeoutSec: Number(event.target.value) })}
          />
        </label>
        <label>
          Keep finished jobs (days, 0 = until cleared)
          <input
            type="number"
            min={0}
            max={3650}
            value={draft.jobRetentionDays}
            onChange={(event) => set({ jobRetentionDays: Number(event.target.value) })}
          />
        </label>

        {adapterNames
          .filter((name) => name !== 'fake')
          .map((name) => (
            <fieldset key={name}>
              <legend>{name}</legend>
              <label>
                Command
                <input
                  aria-label={`${name} command`}
                  placeholder={name}
                  value={draft.adapters[name]?.command ?? ''}
                  onChange={(event) =>
                    setAdapter(name, { command: event.target.value || undefined })
                  }
                />
              </label>
              <label>
                Model
                <input
                  aria-label={`${name} model`}
                  placeholder="the CLI's default"
                  value={draft.adapters[name]?.model ?? ''}
                  onChange={(event) => setAdapter(name, { model: event.target.value || undefined })}
                />
              </label>
              <label>
                Extra arguments
                <input
                  aria-label={`${name} extra arguments`}
                  value={(draft.adapters[name]?.extraArgs ?? []).join(' ')}
                  onChange={(event) => setAdapter(name, { extraArgs: words(event.target.value) })}
                />
              </label>
            </fieldset>
          ))}

        <footer className="settings-footer">
          <span className="quiet" role="status" aria-label="Settings status">
            {message}
          </span>
          <button type="submit" className="settings-save" disabled={loaded.error !== null}>
            Save
          </button>
        </footer>
      </form>
    </div>
  )
}
