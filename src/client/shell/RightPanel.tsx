import { Composer } from '../jobs/Composer.tsx'
import { ResearchPanel } from '../jobs/ResearchPanel.tsx'
import { Tray } from '../jobs/Tray.tsx'

/**
 * The agent conversation: research notes on top, the jobs as turns, and the message box. The
 * prompt pill (at the selection) and the ghost diffs (on the text) stay where they are.
 */
export function RightPanel() {
  return (
    <>
      <ResearchPanel />
      <Tray inPanel />
      <Composer />
    </>
  )
}
