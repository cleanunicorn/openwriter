import { HERDR_SESSION_SOURCE } from '../names.ts'

/**
 * The one string contract between the herdr adapter (which writes it into a progress line) and
 * the job tray (which turns it into "Open this job in herdr"). Both ends use these functions, so
 * rewording the progress text cannot silently hide the tray's command.
 */
const ATTACH_HINT = new RegExp(`attach with: (herdr session attach ${HERDR_SESSION_SOURCE})`)

const herdrAttachCommand = (session: string): string => `herdr session attach ${session}`

export const herdrAttachHint = (session: string): string =>
  `attach with: ${herdrAttachCommand(session)}`

export function parseHerdrAttachHint(line: string): string | null {
  return line.match(ATTACH_HINT)?.[1] ?? null
}
