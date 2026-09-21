import type { ReactNode } from 'react'
import { docKey } from '../../shared/api-types.ts'
import { allCommands, type Command } from '../palette/commands.ts'
import { currentDoc, openDoc, setPalette, store, useApp } from '../state/app.ts'
import { currentLayout, setLeftOpen } from './state.ts'

/** A click must never take the keyboard from an open block (blur commits it). */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()

/** A pick from the drawer closes it; a docked panel stays where the writer put it. */
const pick = (run: () => void | Promise<void>) => () => {
  if (currentLayout().left === 'overlay') setLeftOpen(false)
  void run()
}

function Item({
  children,
  hint,
  current = false,
  onClick,
}: {
  children: ReactNode
  hint?: string
  current?: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        className="panel-item"
        aria-current={current ? 'page' : undefined}
        onMouseDown={keepFocus}
        onClick={pick(onClick)}
      >
        <span>{children}</span>
        {/* A hint may be cut short with an ellipsis; the tooltip keeps all of it. */}
        {hint !== undefined && (
          <span className="quiet" title={hint}>
            {hint}
          </span>
        )}
      </button>
    </li>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="panel-section" aria-labelledby={id}>
      <h2 id={id} className="panel-heading">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * Files and actions. Every action is a command from the palette's registry, run the same way, so
 * the panel and the palette can never disagree about what exists; the palette still reaches all.
 */
export function LeftPanel() {
  const articles = useApp((state) => state.articles)
  const current = useApp((state) => state.current)
  const workspaces = useApp((state) => state.workspaces)
  // The commands below depend on these; subscribing re-renders the panel when they change.
  useApp((state) => state.config)
  useApp((state) => state.skills)
  useApp((state) => currentDoc(state)?.status)
  const commands = allCommands(store.get())
  const command = (id: string): Command | undefined => commands.find((c) => c.id === id)
  const currentKey = current === null ? null : docKey(current)

  const switches = commands.filter((c) => c.id.startsWith('workspace-open:'))
  const newArticle = command('new-article')
  const strategy = command('edit-strategy')
  const brief = command('edit-brief')
  const actions = [
    ...commands.filter((c) => c.group === 'export'),
    ...['theme', 'settings'].flatMap((id) => command(id) ?? []),
  ]

  return (
    <>
      <Section id="left-workspace" title="Workspace">
        <p className="panel-current">{workspaces?.active.label ?? '…'}</p>
        <ul className="panel-list">
          {switches.length > 0 && (
            <li>
              <details className="panel-switch">
                <summary>Switch workspace</summary>
                <ul className="panel-list">
                  {switches.map((c) => (
                    // The path tells two workspaces with the same name apart.
                    <Item key={c.id} hint={c.hint} onClick={c.run}>
                      {c.title.replace(/^Switch to workspace: /, '')}
                    </Item>
                  ))}
                </ul>
              </details>
            </li>
          )}
          {['workspace-open-path', 'workspace-new'].map((id) => {
            const c = command(id)
            return c === undefined ? null : (
              <Item key={id} onClick={c.run}>
                {c.title}
              </Item>
            )
          })}
        </ul>
      </Section>

      <Section id="left-documents" title="Documents">
        <ul className="panel-list">
          {articles.map((article) => {
            const ref = { kind: 'article', slug: article.slug } as const
            return (
              <Item
                key={article.slug}
                current={currentKey === docKey(ref)}
                onClick={() => openDoc(ref)}
              >
                {article.title}
              </Item>
            )
          })}
          {articles.length === 0 && <li className="quiet">No articles yet</li>}
          {newArticle !== undefined && <Item onClick={newArticle.run}>New article…</Item>}
        </ul>
        <ul className="panel-list">
          {strategy !== undefined && (
            <Item current={current?.kind === 'strategy'} onClick={strategy.run}>
              strategy.md
            </Item>
          )}
          {brief !== undefined && (
            <Item hint={brief.hint} current={current?.kind === 'brief'} onClick={brief.run}>
              Brief
            </Item>
          )}
        </ul>
      </Section>

      <Section id="left-actions" title="Actions">
        <ul className="panel-list">
          {actions.map((c) => (
            // No hint here: they were written for the wide palette, and the titles say enough.
            <Item key={c.id} onClick={c.run}>
              {c.title}
            </Item>
          ))}
          <Item hint="Ctrl/Cmd+K" onClick={() => setPalette({ kind: 'commands' })}>
            All commands
          </Item>
        </ul>
      </Section>
    </>
  )
}
