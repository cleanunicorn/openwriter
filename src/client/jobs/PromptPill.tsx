import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { DocRef } from '../../shared/api-types.ts'
import type { Scope } from '../../shared/jobs/job-types.ts'
import { SKILL_NAME_SOURCE } from '../../shared/names.ts'
import { requestJob } from '../state/jobs.ts'

/** `/skill-name rest of the instruction` */
const SLASH_SKILL = new RegExp(`^/(${SKILL_NAME_SOURCE})\\s*(.*)$`, 's')

export type PillTarget = {
  docRef: DocRef
  targets: string[]
  selection?: { blockId: string; text: string; from?: number; to?: number }
  /**
   * Where the pill sits, relative to a block: the layout can change while it is open (a diagram
   * finishes rendering, a ghost arrives), so the position is recomputed, never frozen in pixels.
   */
  anchor: { blockId: string; offsetTop: number; left: number } | null
  scope?: Scope
  skill?: string
  placeholder?: string
  autoFocus?: boolean
}

/**
 * The small prompt near a selection: type an instruction, press Enter, carry on. `/name ` at the
 * start runs a skill. The pill never blocks: the job starts or queues and the pill disappears.
 */
export function PromptPill({ target, onClose }: { target: PillTarget; onClose: () => void }) {
  const [text, setText] = useState('')
  const [scope, setScope] = useState<Scope>(target.scope ?? 'blocks')
  const input = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    const column = document.querySelector<HTMLElement>('.column')
    if (column === null) return
    const place = () => {
      const anchor = target.anchor
      const block =
        anchor === null
          ? null
          : column.querySelector<HTMLElement>(
              `[data-testid="block"][data-block-id="${anchor.blockId}"]`,
            )
      if (anchor === null || block === null) return setPosition({ top: 8, left: 0 })
      const top =
        block.getBoundingClientRect().top - column.getBoundingClientRect().top + anchor.offsetTop
      setPosition({ top, left: anchor.left })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(column)
    return () => observer.disconnect()
  }, [target.anchor])

  // The pill never steals focus by appearing: a selection stays a selection (it can be copied,
  // extended, typed over). Palette actions ask for focus explicitly.
  useEffect(() => {
    if (target.autoFocus) input.current?.focus()
  }, [target.autoFocus])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const typed = text.trim()
    const slash = typed.match(SLASH_SKILL)
    const skill = slash?.[1] ?? target.skill
    const body = (slash === null ? typed : (slash[2] ?? '')).trim()
    // A skill with no words after it runs bare.
    const instruction = body === '' && skill !== undefined ? `Run the ${skill} skill.` : body
    if (instruction === '') return
    requestJob({
      doc: target.docRef,
      scope,
      instruction,
      skill,
      targets: scope === 'research' ? [] : target.targets,
      selection: scope === 'blocks' ? target.selection : undefined,
    })
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <form
      className="pill"
      style={position}
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-label="Ask the agent"
    >
      <input
        ref={input}
        className="pill-input"
        aria-label="Instruction for the agent"
        placeholder={target.placeholder ?? 'Tell the agent what to do… (Ctrl/Cmd+I)'}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <select
        className="pill-scope"
        aria-label="Scope"
        value={scope}
        onChange={(event) => setScope(event.target.value as Scope)}
      >
        <option value="blocks">selection</option>
        <option value="article">whole article</option>
        <option value="research">research</option>
      </select>
    </form>
  )
}
