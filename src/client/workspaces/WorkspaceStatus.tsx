import { notifyFailure, useApp } from '../state/app.ts'
import { discardAndFollow, returnAndSave } from './switch.ts'

const run = (what: string, action: () => Promise<void>) => () =>
  void action().catch((error: unknown) => notifyFailure(what, error))

/**
 * What the workspace switch has to say above the document: that one is under way, or that another
 * tab moved the server while this one held unsaved text. The second stays until the writer
 * chooses; it is the one place where text could otherwise be dropped without a word.
 */
export function WorkspaceStatus() {
  const switching = useApp((state) => state.switching)
  const moved = useApp((state) => state.moved)
  const shown = useApp((state) => state.workspaces?.active.label ?? 'this workspace')

  return (
    <>
      {switching !== null && (
        <p className="notice" role="status" aria-label="Workspace switch">
          {switching}
        </p>
      )}
      {moved !== null && (
        <div className="notice notice-warn" role="alert" aria-label="Workspace moved">
          <p>
            Another tab opened the workspace “{moved.label}”. The changes here belong to “{shown}”
            and are not saved yet; autosave is paused until you choose.
          </p>
          <p className="notice-actions">
            <button
              type="button"
              className="link"
              disabled={switching !== null}
              onClick={run('Could not go back', returnAndSave)}
            >
              Go back to “{shown}” and save
            </button>
            <button
              type="button"
              className="link warn"
              disabled={switching !== null}
              onClick={run('Could not follow the workspace change', discardAndFollow)}
            >
              Discard the changes and open “{moved.label}”
            </button>
          </p>
        </div>
      )}
    </>
  )
}
