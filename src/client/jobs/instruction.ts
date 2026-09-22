import { SKILL_NAME_SOURCE } from '../../shared/names.ts'

/** `/skill-name rest of the instruction` */
const SLASH_SKILL = new RegExp(`^/(${SKILL_NAME_SOURCE})\\s*(.*)$`, 's')

/** What was typed, as a job's instruction and skill: `/name` runs a skill; alone it runs bare. */
export function parseInstruction(
  text: string,
  fallbackSkill?: string,
): { instruction: string; skill: string | undefined } {
  const typed = text.trim()
  const slash = typed.match(SLASH_SKILL)
  const skill = slash?.[1] ?? fallbackSkill
  const body = (slash === null ? typed : (slash[2] ?? '')).trim()
  return {
    instruction: body === '' && skill !== undefined ? `Run the ${skill} skill.` : body,
    skill,
  }
}

/**
 * Whether a key in the message box sends the message: Enter does; Shift+Enter starts a new line,
 * and an Enter that ends an IME composition (Japanese, Chinese, …) only confirms the characters.
 */
export const sendsMessage = (key: { key: string; shiftKey: boolean; isComposing: boolean }) =>
  key.key === 'Enter' && !key.shiftKey && !key.isComposing
