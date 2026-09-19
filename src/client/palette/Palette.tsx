import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { type PaletteMode, setPalette, store, useApp } from '../state/app.ts'
import { useRestoreFocus } from '../use-restore-focus.ts'
import { allCommands, filterCommands } from './commands.ts'

/** `Cmd/Ctrl+K`: a filtered list of commands, or a one-line input a command asked for. */
export function Palette({ mode }: { mode: PaletteMode }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useRestoreFocus()
  const articles = useApp((state) => state.articles)
  const config = useApp((state) => state.config)
  const skills = useApp((state) => state.skills)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the list depends on app state slices
  const commands = useMemo(
    () => (mode.kind === 'commands' ? filterCommands(allCommands(store.get()), query) : []),
    [mode, query, articles, config, skills],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the mode changes
  useEffect(() => {
    setQuery('')
    setActive(0)
    input.current?.focus()
  }, [mode])

  const close = () => setPalette(null)

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(index + 1, commands.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (mode.kind === 'input') {
        if (query.trim() === '') return
        close()
        mode.submit(query.trim())
        return
      }
      const command = commands[active]
      if (command === undefined) return
      close()
      void command.run()
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-away on the backdrop; Esc is the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes from the input
    <div className="palette-backdrop" onClick={close}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops the backdrop click */}
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded={mode.kind === 'commands'}
          aria-controls="palette-list"
          aria-activedescendant={
            mode.kind === 'commands' && commands[active] !== undefined
              ? `palette-option-${active}`
              : undefined
          }
          aria-label={mode.kind === 'input' ? mode.label : 'Command palette'}
          placeholder={mode.kind === 'input' ? mode.placeholder : 'Type a command…'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        {mode.kind === 'commands' && (
          <div id="palette-list" role="listbox" aria-label="Commands" className="palette-list">
            {commands.map((command, index) => (
              <div
                key={command.id}
                id={`palette-option-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                className={`palette-item ${index === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  close()
                  void command.run()
                }}
              >
                <span>{command.title}</span>
                {command.hint !== undefined && <span className="quiet">{command.hint}</span>}
              </div>
            ))}
            {commands.length === 0 && <div className="palette-item quiet">No matching command</div>}
          </div>
        )}
      </div>
    </div>
  )
}
