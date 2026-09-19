/**
 * The one string contract between the herdr adapter (which writes it into a progress line) and
 * the job tray (which turns it into "Open this job in herdr"). Both ends use these functions, so
 * rewording the progress text cannot silently hide the tray's command.
 */
export const herdrAttachCommand = (session: string): string => `herdr session attach ${session}`

export const herdrAttachHint = (session: string): string =>
  `attach with: ${herdrAttachCommand(session)}`

export function parseHerdrAttachHint(line: string): string | null {
  return line.match(/attach with: (herdr session attach [a-z0-9][a-z0-9-]*)/)?.[1] ?? null
}
