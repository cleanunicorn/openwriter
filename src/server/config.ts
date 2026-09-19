import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type Config, ConfigSchema, DEFAULT_CONFIG } from '../shared/config-schema.ts'

export type LoadedConfig = { config: Config; error: string | null }

export const configPath = (workspace: string) => path.join(workspace, '.zen', 'config.json')

/** Read and validate `.zen/config.json`. An invalid file yields defaults plus the error. */
export function loadConfig(workspace: string): LoadedConfig {
  const file = configPath(workspace)
  if (!existsSync(file)) return { config: DEFAULT_CONFIG, error: null }
  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (parsed.success) return { config: parsed.data, error: null }
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    return { config: DEFAULT_CONFIG, error: issues.join('; ') }
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      error: `config.json is not valid JSON: ${(error as Error).message}`,
    }
  }
}

/** Atomic write. Refuses to replace a file the writer has to repair by hand first. */
export function saveConfig(workspace: string, config: Config): void {
  if (loadConfig(workspace).error !== null) {
    throw new Error('config.json is invalid; fix or remove it before changing settings')
  }
  const file = configPath(workspace)
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(temp, file)
}
