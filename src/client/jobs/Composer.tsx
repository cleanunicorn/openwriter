import { type FormEvent, type KeyboardEvent, useRef } from 'react'
import { allCommands } from '../palette/commands.ts'
import { currentDoc, store, useApp } from '../state/app.ts'
import { requestJob, setComposer, startNewConversation, threadOf, useJobs } from '../state/jobs.ts'
import { targetsFor } from './commands.ts'
import { parseInstruction } from './PromptPill.tsx'

/**
 * The right panel's message box: whole-article instructions and research questions, `/name` for
 * a skill. A part of the text is still asked about from the pill, where the selection is. Every
 * message is an ordinary job, so it queues, runs and is reviewed exactly like one from the pill.
 */
export function Composer() {
  const draft = useJobs((state) => state.composer)
  const empty = useJobs((state) => state.order.length === 0 && state.held.length === 0)
  const doc = useApp(currentDoc)
  const skills = useApp((state) => state.skills)
  const input = useRef<HTMLTextAreaElement>(null)
  // How many earlier turns the next message carries to the agent (a number: a stable snapshot).
  const carried = useJobs((state) => (doc === null ? 0 : threadOf(state, doc.ref).length))
  const ready = doc !== null && doc.status === 'ready'
  const currentSkills = skills.filter((skill) => skill.document === 'current')
  const starters = ready
    ? allCommands(store.get()).filter((c) => c.id === 'draft-brief' || c.id === 'draft-article')
    : []

  const send = () => {
    if (!ready) return
    const { instruction, skill } = parseInstruction(draft.text)
    if (instruction === '') return
    const content = doc.doc.blocks
      .filter((block) => block.kind === 'content')
      .map((block) => block.id)
    // A skill keeps its own scope, as it does from the palette; otherwise the chosen one.
    const scope = currentSkills.find((s) => s.name === skill)?.scope ?? draft.scope
    requestJob({
      doc: doc.ref,
      scope,
      instruction,
      skill,
      targets: targetsFor(scope, doc.selectedIds, content),
    })
    setComposer({ text: '' })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    send()
  }
  // Enter sends, Shift+Enter starts a new line — the pill's Enter, with room to write more.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send()
    }
  }
  const prefill = (text: string) => {
    setComposer({ text })
    input.current?.focus()
  }

  return (
    <div className="composer">
      {empty && (
        <div className="composer-start">
          <p className="quiet">
            Ask about the whole article or research a question here. For part of the text, select it
            and type.
          </p>
          {starters.length > 0 && (
            <ul className="panel-list">
              {starters.map((c) => (
                <li key={c.id}>
                  <button type="button" className="panel-item" onClick={() => void c.run()}>
                    <span>{c.title}</span>
                    <span className="quiet">a job you review</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <form className="composer-form" onSubmit={onSubmit}>
        <textarea
          ref={input}
          className="composer-input"
          aria-label="Message to the agent"
          placeholder={ready ? 'Tighten the intro… or /diagram …' : 'Open a document first'}
          rows={3}
          disabled={!ready}
          value={draft.text}
          onChange={(event) => setComposer({ text: event.target.value })}
          onKeyDown={onKeyDown}
        />
        <div className="composer-row">
          <select
            aria-label="Ask about"
            value={draft.scope}
            disabled={!ready}
            onChange={(event) =>
              setComposer({ scope: event.target.value === 'research' ? 'research' : 'article' })
            }
          >
            <option value="article">whole article</option>
            <option value="research">research</option>
          </select>
          <button type="submit" className="link" disabled={!ready}>
            Send
          </button>
        </div>
        {carried > 0 && (
          <p className="composer-thread quiet">
            Carries the last {carried} {carried === 1 ? 'turn' : 'turns'} about this document.{' '}
            <button type="button" className="link" onClick={startNewConversation}>
              New conversation
            </button>
          </p>
        )}
        {ready && currentSkills.length > 0 && (
          <div className="composer-skills">
            {currentSkills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                className="chip"
                title={skill.description}
                onClick={() => prefill(`/${skill.name} `)}
              >
                /{skill.name}
              </button>
            ))}
          </div>
        )}
      </form>
    </div>
  )
}
