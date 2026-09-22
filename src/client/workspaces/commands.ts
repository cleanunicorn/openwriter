import type { WorkspaceEntry } from '../../shared/workspaces-schema.ts'
import { registerCommands } from '../palette/commands.ts'
import { inGroup } from '../palette/group.ts'
import { notifyFailure, setPalette } from '../state/app.ts'
import {
  createWorkspace,
  eraseWorkspace,
  forgetWorkspace,
  openWorkspace,
  renameWorkspace,
} from './switch.ts'

const report = (what: string, run: () => Promise<void>) => () =>
  void run().catch((error: unknown) => notifyFailure(what, error))

const askForPath = (label: string, placeholder: string, run: (path: string) => Promise<void>) =>
  setPalette({
    kind: 'input',
    label,
    placeholder,
    submit: (path) => report(label, () => run(path))(),
  })

registerCommands((state) => {
  const workspaces = state.workspaces
  if (workspaces === null) return []
  const others = workspaces.entries.filter((entry) => entry.path !== workspaces.active.root)
  const known = (entry: WorkspaceEntry) => entry.path

  return inGroup('workspace', [
    ...others.map((entry) => ({
      id: `workspace-open:${entry.id}`,
      title: `Switch to workspace: ${entry.label}`,
      hint: known(entry),
      run: report('Could not open that workspace', () => openWorkspace(entry.path)),
    })),
    {
      id: 'workspace-open-path',
      title: 'Open workspace…',
      hint: 'by its path on disk',
      run: () =>
        askForPath('Workspace path', 'Absolute path of the workspace to open', (path) =>
          openWorkspace(path),
        ),
    },
    {
      id: 'workspace-new',
      title: 'New workspace…',
      hint: 'scaffold and open it',
      run: () =>
        askForPath('New workspace path', 'Absolute path of a new or empty directory', (path) =>
          createWorkspace(path),
        ),
    },
    ...workspaces.entries.map((entry) => ({
      id: `workspace-rename:${entry.id}`,
      title: `Rename workspace: ${entry.label}`,
      hint: known(entry),
      run: () =>
        setPalette({
          kind: 'input',
          label: `New name for ${entry.label}`,
          placeholder: entry.label,
          submit: (label) =>
            report('Could not rename that workspace', () => renameWorkspace(entry.id, label))(),
        }),
    })),
    ...others.map((entry) => ({
      id: `workspace-forget:${entry.id}`,
      title: `Remove workspace from the list: ${entry.label}`,
      hint: 'keeps every file on disk',
      run: report('Could not remove that workspace', () => forgetWorkspace(entry.id)),
    })),
    ...others.map((entry) => ({
      id: `workspace-erase:${entry.id}`,
      title: `Delete workspace from disk: ${entry.label}`,
      hint: 'irreversible',
      run: () =>
        setPalette({
          kind: 'confirm',
          label: `Delete ${entry.label} from disk`,
          placeholder: `Type ${entry.label} to delete it — this cannot be undone`,
          phrase: entry.label,
          submit: report('Could not delete that workspace', () =>
            eraseWorkspace(entry.id, entry.label),
          ),
        }),
    })),
  ])
})
